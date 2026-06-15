// AgentEye — embedded SQLite data-access layer (S0).
//
// Replaces the flat-JSON CRUD in auth.js + store.js with one ACID store, fixing the
// concurrent read-modify-write races those had and giving the journey state machine /
// run-tracking (later slices) a real home. Uses Node's built-in `node:sqlite`
// (Node 22.5+ — zero external dependency); if that ever regresses, the only swap point
// is this file (the rest of the app talks to the repository functions below).
//
// Boundaries:
//   • This DB holds OPERATIONAL, mutable state (users, sessions, projects, drafts,
//     conversations, per-project stores, audit). The Library/Catalog stays git-backed
//     on disk — artifacts + provenance live there; the DB never owns them.
//   • Tenant-ready: rows carry a nullable org_id so multi-tenancy (SaaS) is a column
//     fill, not a schema rewrite.
//   • All blobs (draft/conversation/store payloads) are stored as JSON text columns.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// node:sqlite is still flagged experimental — suppress only that one load-time warning.
const _emit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : (w && w.message) || '';
  const type = rest[0] && typeof rest[0] === 'object' ? rest[0].type : rest[0];
  if (type === 'ExperimentalWarning' || /SQLite is an experimental feature/i.test(msg)) return;
  return _emit.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = _emit;

const AUTH_DIR = path.join(__dirname, '..', '.auth');     // gitignored
const DB_PATH  = path.join(AUTH_DIR, 'agenteye.db');

function newId() { return crypto.randomBytes(8).toString('hex'); }
function now()   { return new Date().toISOString(); }

// ── connection + schema ──────────────────────────────────────────────────────
let db = null;
function getDb() {
  if (db) return db;
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT,
      pass_hash TEXT NOT NULL, salt TEXT NOT NULL, is_admin INTEGER DEFAULT 0,
      org_id TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER, expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT,
      name TEXT, description TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT NOT NULL, project_id TEXT NOT NULL, data TEXT,
      created_at TEXT, updated_at TEXT, PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT NOT NULL, project_id TEXT NOT NULL, data TEXT,
      created_at TEXT, updated_at TEXT, PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS stores (
      project_id TEXT PRIMARY KEY, data TEXT
    );
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
      created_at TEXT, PRIMARY KEY (project_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user_id TEXT,
      action TEXT, target TEXT, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
  `);
  migrateFromJson();           // one-time import of any pre-existing flat-JSON data
  return db;
}

// ── audit ────────────────────────────────────────────────────────────────────
function audit(userId, action, target, detail) {
  try {
    getDb().prepare('INSERT INTO audit (ts,user_id,action,target,detail) VALUES (?,?,?,?,?)')
      .run(now(), userId || null, action || null, target || null, detail ? String(detail).slice(0, 2000) : null);
  } catch { /* audit is best-effort */ }
}

// ── users / sessions (auth.js calls these) ────────────────────────────────────
function usersCount()            { return getDb().prepare('SELECT COUNT(*) c FROM users').get().c; }
function getUserByUsername(uname) { return getDb().prepare('SELECT * FROM users WHERE username=?').get(uname) || null; }
function getUserById(id)          { return getDb().prepare('SELECT * FROM users WHERE id=?').get(id) || null; }
function insertUser(u) {
  getDb().prepare(`INSERT INTO users (id,username,display_name,pass_hash,salt,is_admin,org_id,created_at)
                   VALUES (?,?,?,?,?,?,?,?)`)
    .run(u.id, u.username, u.displayName, u.passHash, u.salt, u.isAdmin ? 1 : 0, u.orgId || null, u.createdAt);
}
function insertSession(token, userId, createdAt, expiresAt) {
  getDb().prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(token, userId, createdAt, expiresAt);
}
function getSession(token)           { return getDb().prepare('SELECT * FROM sessions WHERE token=?').get(token) || null; }
function deleteSession(token)        { getDb().prepare('DELETE FROM sessions WHERE token=?').run(token); }
function pruneExpiredSessions(nowMs) { getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowMs); }
function touchSession(token, exp)    { getDb().prepare('UPDATE sessions SET expires_at=? WHERE token=?').run(exp, token); }

// ── RBAC (S8): the project owner is implicit admin; others get a shared role ─────
const ROLE_RANK = { viewer: 1, reviewer: 2, architect: 3, admin: 4 };
function isRole(r) { return Object.prototype.hasOwnProperty.call(ROLE_RANK, r); }
// Returns the actor's role on a project ('admin' for the owner, the membership role for
// a shared user, or null if no access). Owner identity is projects.user_id.
function roleFor(userId, projectId) {
  const p = getDb().prepare('SELECT user_id FROM projects WHERE id=?').get(projectId);
  if (!p) return null;
  if (p.user_id === userId) return 'admin';
  const m = getDb().prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(projectId, userId);
  return m ? m.role : null;
}
// Throws 'project not found' if no access (hides existence), or a forbidden error if the
// role rank is below minRole. Returns the actor's role on success.
function requireAccess(userId, projectId, minRole) {
  const r = roleFor(userId, projectId);
  if (r == null) throw new Error('project not found');
  if (ROLE_RANK[r] < ROLE_RANK[minRole]) { const e = new Error(`forbidden: this action requires '${minRole}' (you are '${r}')`); e.forbidden = true; throw e; }
  return r;
}

// ── projects (role-aware: owned OR shared) ─────────────────────────────────────
function projectRow(projectId) {
  return getDb().prepare('SELECT id,user_id,name,description,created_at createdAt,updated_at updatedAt FROM projects WHERE id=?').get(projectId) || null;
}
function shape(p, role, userId) { return p && { id: p.id, name: p.name, description: p.description, createdAt: p.createdAt, updatedAt: p.updatedAt, role, owner: p.user_id === userId, ownerId: p.user_id }; }
function listProjects(userId) {
  const owned  = getDb().prepare('SELECT id,user_id,name,description,created_at createdAt,updated_at updatedAt FROM projects WHERE user_id=?').all(userId);
  const shared = getDb().prepare('SELECT p.id,p.user_id,p.name,p.description,p.created_at createdAt,p.updated_at updatedAt, m.role role FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.user_id=?').all(userId);
  const out = owned.map(p => shape(p, 'admin', userId)).concat(shared.map(p => shape(p, p.role, userId)));
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
function getProject(userId, projectId) {
  const role = roleFor(userId, projectId);
  if (!role) return null;
  return shape(projectRow(projectId), role, userId);
}
function createProject(userId, { name, description } = {}) {
  const proj = {
    id: newId(),
    name: String(name || 'Untitled project').trim().slice(0, 120) || 'Untitled project',
    description: String(description || '').trim().slice(0, 500),
    createdAt: now(), updatedAt: now(),
  };
  getDb().prepare('INSERT INTO projects (id,user_id,org_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(proj.id, userId, null, proj.name, proj.description, proj.createdAt, proj.updatedAt);
  audit(userId, 'project.create', proj.id, proj.name);
  return { ...proj, role: 'admin', owner: true, ownerId: userId };
}
function renameProject(userId, projectId, { name, description } = {}) {
  requireAccess(userId, projectId, 'admin');
  const p = projectRow(projectId);
  const name2 = name != null ? (String(name).trim().slice(0, 120) || p.name) : p.name;
  const desc2 = description != null ? String(description).trim().slice(0, 500) : p.description;
  const ts = now();
  getDb().prepare('UPDATE projects SET name=?,description=?,updated_at=? WHERE id=?').run(name2, desc2, ts, projectId);
  audit(userId, 'project.rename', projectId, name2);
  return shape(projectRow(projectId), 'admin', userId);
}
function deleteProject(userId, projectId) {
  if (!roleFor(userId, projectId)) return true;
  requireAccess(userId, projectId, 'admin');   // owner/admin only
  const d = getDb();
  const p = projectRow(projectId);
  ['drafts', 'conversations', 'stores', 'project_members'].forEach(t => d.prepare(`DELETE FROM ${t} WHERE project_id=?`).run(projectId));
  d.prepare('DELETE FROM projects WHERE id=?').run(projectId);
  audit(userId, 'project.delete', projectId, p && p.name);
  return true;
}
function touchProject(projectId) { getDb().prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(), projectId); }

// ── project members (S8) ───────────────────────────────────────────────────────
function listMembers(userId, projectId) {
  requireAccess(userId, projectId, 'viewer');
  const p = projectRow(projectId);
  const owner = getUserById(p.user_id);
  const members = [{ userId: p.user_id, username: owner && owner.username, displayName: owner && owner.display_name, role: 'admin', owner: true }];
  getDb().prepare('SELECT m.user_id, m.role, u.username, u.display_name FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?').all(projectId)
    .forEach(m => members.push({ userId: m.user_id, username: m.username, displayName: m.display_name, role: m.role, owner: false }));
  return members;
}
function addMember(userId, projectId, username, role) {
  requireAccess(userId, projectId, 'admin');
  if (!isRole(role) || role === 'admin') throw new Error('role must be one of: viewer, reviewer, architect');
  const target = getUserByUsername(String(username || '').trim().toLowerCase());
  if (!target) throw new Error('no such user: ' + username);
  const p = projectRow(projectId);
  if (target.id === p.user_id) throw new Error('that user is the owner');
  getDb().prepare(`INSERT INTO project_members (project_id,user_id,role,created_at) VALUES (?,?,?,?)
                   ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role`)
    .run(projectId, target.id, role, now());
  audit(userId, 'project.member.add', projectId, `${target.username}:${role}`);
  return { userId: target.id, username: target.username, displayName: target.display_name, role, owner: false };
}
function setMemberRole(userId, projectId, targetUserId, role) {
  requireAccess(userId, projectId, 'admin');
  if (!isRole(role) || role === 'admin') throw new Error('role must be one of: viewer, reviewer, architect');
  const r = getDb().prepare('UPDATE project_members SET role=? WHERE project_id=? AND user_id=?').run(role, projectId, targetUserId);
  if (!r.changes) throw new Error('not a member');
  audit(userId, 'project.member.role', projectId, `${targetUserId}:${role}`);
  return true;
}
function removeMember(userId, projectId, targetUserId) {
  requireAccess(userId, projectId, 'admin');
  getDb().prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(projectId, targetUserId);
  audit(userId, 'project.member.remove', projectId, targetUserId);
  return true;
}

// ── items: drafts / conversations (role-gated; optimistic concurrency via version) ─
const TABLES = { drafts: 'drafts', conversations: 'conversations' };
function itemTable(kind) { const t = TABLES[kind]; if (!t) throw new Error('bad item kind'); return t; }

function listItems(userId, projectId, kind) {
  requireAccess(userId, projectId, 'viewer');
  const rows = getDb().prepare(`SELECT data FROM ${itemTable(kind)} WHERE project_id=? ORDER BY updated_at DESC`).all(projectId);
  return rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
}
function getItem(userId, projectId, kind, itemId) {
  requireAccess(userId, projectId, 'viewer');
  const r = getDb().prepare(`SELECT data FROM ${itemTable(kind)} WHERE project_id=? AND id=?`).get(projectId, itemId);
  if (!r) return null;
  try { return JSON.parse(r.data); } catch { return null; }
}
function putItem(userId, projectId, kind, itemId, data) {
  requireAccess(userId, projectId, 'architect');
  const id = String(itemId || newId());
  const existing = getDb().prepare(`SELECT data FROM ${itemTable(kind)} WHERE project_id=? AND id=?`).get(projectId, id);
  const prev = existing ? (() => { try { return JSON.parse(existing.data); } catch { return {}; } })() : {};
  const { expectedVersion, ...rest } = data || {};
  // optimistic concurrency: reject a stale write so concurrent editors don't clobber each other
  if (expectedVersion != null && prev.version != null && prev.version !== expectedVersion) {
    const e = new Error('conflict: this was updated by someone else — reload before saving'); e.conflict = true; e.currentVersion = prev.version; throw e;
  }
  const merged = { ...prev, ...rest, id, updatedAt: now(), version: (prev.version || 0) + 1 };
  if (!merged.createdAt) merged.createdAt = merged.updatedAt;
  getDb().prepare(`INSERT INTO ${itemTable(kind)} (id,project_id,data,created_at,updated_at)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
    .run(id, projectId, JSON.stringify(merged), merged.createdAt, merged.updatedAt);
  touchProject(projectId);
  return merged;
}
function deleteItem(userId, projectId, kind, itemId) {
  requireAccess(userId, projectId, 'architect');
  getDb().prepare(`DELETE FROM ${itemTable(kind)} WHERE project_id=? AND id=?`).run(projectId, itemId);
  touchProject(projectId);
  return true;
}

// ── per-project stores (migrated browser localStorage) ─────────────────────────
const STORES_DEFAULT = { connectors: {}, agentcore: {}, cognitiveMemory: {}, finopsConn: null };
function getStores(userId, projectId) {
  requireAccess(userId, projectId, 'viewer');
  const r = getDb().prepare('SELECT data FROM stores WHERE project_id=?').get(projectId);
  let v = {}; if (r) { try { v = JSON.parse(r.data); } catch {} }
  return { ...STORES_DEFAULT, ...v };
}
function putStores(userId, projectId, stores) {
  requireAccess(userId, projectId, 'architect');
  const merged = { ...STORES_DEFAULT, ...(stores || {}) };
  getDb().prepare(`INSERT INTO stores (project_id,data) VALUES (?,?)
                   ON CONFLICT(project_id) DO UPDATE SET data=excluded.data`)
    .run(projectId, JSON.stringify(merged));
  touchProject(projectId);
  return merged;
}

// ── one-time migration from the old flat-JSON layout (best-effort, idempotent) ──
let _migrated = false;
function migrateFromJson() {
  if (_migrated) return; _migrated = true;
  try {
    if (usersCount() > 0) return;                          // DB already populated
    const usersFile = path.join(AUTH_DIR, 'users.json');
    if (fs.existsSync(usersFile)) {
      const users = JSON.parse(fs.readFileSync(usersFile, 'utf8') || '{}');
      for (const u of Object.values(users)) {
        try { insertUser({ id: u.id, username: u.username, displayName: u.displayName, passHash: u.passHash, salt: u.salt, isAdmin: u.isAdmin, orgId: u.orgId, createdAt: u.createdAt }); } catch {}
      }
    }
    const sessFile = path.join(AUTH_DIR, 'sessions.json');
    if (fs.existsSync(sessFile)) {
      const sess = JSON.parse(fs.readFileSync(sessFile, 'utf8') || '{}');
      for (const [token, s] of Object.entries(sess)) {
        try { insertSession(token, s.userId, s.createdAt, s.expiresAt); } catch {}
      }
    }
    const wsDir = path.join(__dirname, '..', 'workspaces');
    if (fs.existsSync(wsDir)) {
      for (const userId of fs.readdirSync(wsDir)) {
        const wf = path.join(wsDir, userId, 'workspace.json');
        let projects = [];
        try { projects = (JSON.parse(fs.readFileSync(wf, 'utf8')).projects) || []; } catch {}
        for (const p of projects) {
          try {
            getDb().prepare('INSERT OR IGNORE INTO projects (id,user_id,org_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
              .run(p.id, userId, null, p.name, p.description || '', p.createdAt || now(), p.updatedAt || now());
          } catch {}
          const pdir = path.join(wsDir, userId, p.id);
          for (const kind of ['drafts', 'conversations']) {
            const kdir = path.join(pdir, kind);
            if (!fs.existsSync(kdir)) continue;
            for (const f of fs.readdirSync(kdir).filter(x => x.endsWith('.json'))) {
              try {
                const item = JSON.parse(fs.readFileSync(path.join(kdir, f), 'utf8'));
                getDb().prepare(`INSERT OR IGNORE INTO ${kind} (id,project_id,data,created_at,updated_at) VALUES (?,?,?,?,?)`)
                  .run(item.id, p.id, JSON.stringify(item), item.createdAt || now(), item.updatedAt || now());
              } catch {}
            }
          }
          try {
            const sf = path.join(pdir, 'stores.json');
            if (fs.existsSync(sf)) getDb().prepare('INSERT OR IGNORE INTO stores (project_id,data) VALUES (?,?)').run(p.id, fs.readFileSync(sf, 'utf8'));
          } catch {}
        }
      }
    }
    console.log('  [ok]   migrated existing workspace JSON into agenteye.db');
  } catch (e) {
    console.warn('  [warn] JSON→DB migration skipped:', e.message);
  }
}

// init() — parity with the Postgres backend (async); opens the DB + builds the schema.
async function init() { getDb(); }

module.exports = {
  init, getDb, newId, audit,
  // users / sessions
  usersCount, getUserByUsername, getUserById, insertUser,
  insertSession, getSession, deleteSession, pruneExpiredSessions, touchSession,
  // projects + items + stores
  listProjects, getProject, createProject, renameProject, deleteProject,
  listItems, getItem, putItem, deleteItem, getStores, putStores,
  // RBAC + members (S8)
  roleFor, listMembers, addMember, setMemberRole, removeMember,
};
