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
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, user_id TEXT,
      action TEXT, target TEXT, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
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

// ── projects (store.js calls these; ownership enforced by user_id) ─────────────
function listProjects(userId) {
  return getDb().prepare('SELECT id,name,description,created_at createdAt,updated_at updatedAt FROM projects WHERE user_id=? ORDER BY updated_at DESC')
    .all(userId);
}
function getProject(userId, projectId) {
  return getDb().prepare('SELECT id,name,description,created_at createdAt,updated_at updatedAt FROM projects WHERE user_id=? AND id=?')
    .get(userId, projectId) || null;
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
  return proj;
}
function renameProject(userId, projectId, { name, description } = {}) {
  const p = getProject(userId, projectId);
  if (!p) throw new Error('project not found');
  if (name != null) p.name = String(name).trim().slice(0, 120) || p.name;
  if (description != null) p.description = String(description).trim().slice(0, 500);
  p.updatedAt = now();
  getDb().prepare('UPDATE projects SET name=?,description=?,updated_at=? WHERE user_id=? AND id=?')
    .run(p.name, p.description, p.updatedAt, userId, projectId);
  audit(userId, 'project.rename', projectId, p.name);
  return p;
}
function deleteProject(userId, projectId) {
  const d = getDb();
  const owned = getProject(userId, projectId);
  if (!owned) return true;
  d.prepare('DELETE FROM drafts WHERE project_id=?').run(projectId);
  d.prepare('DELETE FROM conversations WHERE project_id=?').run(projectId);
  d.prepare('DELETE FROM stores WHERE project_id=?').run(projectId);
  d.prepare('DELETE FROM projects WHERE user_id=? AND id=?').run(userId, projectId);
  audit(userId, 'project.delete', projectId, owned.name);
  return true;
}
function touchProject(userId, projectId) {
  getDb().prepare('UPDATE projects SET updated_at=? WHERE user_id=? AND id=?').run(now(), userId, projectId);
}
function assertProject(userId, projectId) { if (!getProject(userId, projectId)) throw new Error('project not found'); }

// ── items: drafts / conversations (table chosen by `kind`) ─────────────────────
const TABLES = { drafts: 'drafts', conversations: 'conversations' };
function itemTable(kind) { const t = TABLES[kind]; if (!t) throw new Error('bad item kind'); return t; }

function listItems(userId, projectId, kind) {
  assertProject(userId, projectId);
  const rows = getDb().prepare(`SELECT data FROM ${itemTable(kind)} WHERE project_id=? ORDER BY updated_at DESC`).all(projectId);
  return rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
}
function getItem(userId, projectId, kind, itemId) {
  const r = getDb().prepare(`SELECT data FROM ${itemTable(kind)} WHERE project_id=? AND id=?`).get(projectId, itemId);
  if (!r) return null;
  try { return JSON.parse(r.data); } catch { return null; }
}
function putItem(userId, projectId, kind, itemId, data) {
  assertProject(userId, projectId);
  const id = String(itemId || newId());
  const existing = getItem(userId, projectId, kind, id) || {};
  const merged = { ...existing, ...data, id, updatedAt: now() };
  if (!merged.createdAt) merged.createdAt = merged.updatedAt;
  getDb().prepare(`INSERT INTO ${itemTable(kind)} (id,project_id,data,created_at,updated_at)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
    .run(id, projectId, JSON.stringify(merged), merged.createdAt, merged.updatedAt);
  touchProject(userId, projectId);
  return merged;
}
function deleteItem(userId, projectId, kind, itemId) {
  getDb().prepare(`DELETE FROM ${itemTable(kind)} WHERE project_id=? AND id=?`).run(projectId, itemId);
  touchProject(userId, projectId);
  return true;
}

// ── per-project stores (migrated browser localStorage) ─────────────────────────
const STORES_DEFAULT = { connectors: {}, agentcore: {}, cognitiveMemory: {}, finopsConn: null };
function getStores(userId, projectId) {
  assertProject(userId, projectId);
  const r = getDb().prepare('SELECT data FROM stores WHERE project_id=?').get(projectId);
  let v = {}; if (r) { try { v = JSON.parse(r.data); } catch {} }
  return { ...STORES_DEFAULT, ...v };
}
function putStores(userId, projectId, stores) {
  assertProject(userId, projectId);
  const merged = { ...STORES_DEFAULT, ...(stores || {}) };
  getDb().prepare(`INSERT INTO stores (project_id,data) VALUES (?,?)
                   ON CONFLICT(project_id) DO UPDATE SET data=excluded.data`)
    .run(projectId, JSON.stringify(merged));
  touchProject(userId, projectId);
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

module.exports = {
  getDb, newId, audit,
  // users / sessions
  usersCount, getUserByUsername, getUserById, insertUser,
  insertSession, getSession, deleteSession, pruneExpiredSessions, touchSession,
  // projects + items + stores
  listProjects, getProject, createProject, renameProject, deleteProject,
  listItems, getItem, putItem, deleteItem, getStores, putStores,
};
