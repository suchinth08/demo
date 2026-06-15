// AgentEye — Postgres data-access layer (P1). Mirror of db.sqlite.js, async, on `pg`.
//
// Selected by workspace/db.js when DATABASE_URL is set (Supabase in the hosted deploy).
// Same function surface as the SQLite backend; every function is async. Notes on the
// SQLite→Postgres port:
//   • `?` placeholders → `$1,$2,…`; `.get()`→rows[0]; `.all()`→rows; `.run().changes`→rowCount.
//   • column aliases quoted ("createdAt") so Postgres keeps camelCase keys (unquoted folds to lowercase).
//   • `INSERT … ON CONFLICT (…) DO UPDATE SET x=EXCLUDED.x` (same idea as SQLite's excluded.x).
//   • session epoch columns are BIGINT; int8 is parsed back to Number (see setTypeParser) so
//     the `expires_at < Date.now()` comparisons stay numeric.
//   • deleteProject runs in a transaction. Table names interpolated into SQL come only from
//     the internal TABLES whitelist / hardcoded lists — never from user input.
//
// Boundaries are unchanged from the SQLite backend: this DB owns operational, mutable state
// only; the Library/Catalog stays git-backed on disk. Rows carry a nullable org_id for tenancy.

const crypto = require('crypto');
const { Pool, types } = require('pg');

// int8 (BIGINT) defaults to string in node-postgres → parse to Number (epoch-ms fits safely).
types.setTypeParser(20, v => (v == null ? null : parseInt(v, 10)));

function newId() { return crypto.randomBytes(8).toString('hex'); }
function now()   { return new Date().toISOString(); }

// ── connection ────────────────────────────────────────────────────────────────
let pool = null;
function getPool() {
  if (pool) return pool;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.PG_POOL_MAX, 10) || 8,
    // Supabase requires TLS; its cert may not chain to the local root store, so we
    // don't verify the chain (traffic is still encrypted). Set PG_SSL_STRICT=1 to verify.
    ssl: { rejectUnauthorized: process.env.PG_SSL_STRICT === '1' },
  });
  return pool;
}
const q = (text, params) => getPool().query(text, params);

async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT,
      pass_hash TEXT NOT NULL, salt TEXT NOT NULL, is_admin INTEGER DEFAULT 0,
      org_id TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at BIGINT, expires_at BIGINT
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
      id BIGSERIAL PRIMARY KEY, ts TEXT, user_id TEXT,
      action TEXT, target TEXT, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
  `);
}

// ── audit (best-effort) ─────────────────────────────────────────────────────────
async function audit(userId, action, target, detail) {
  try {
    await q('INSERT INTO audit (ts,user_id,action,target,detail) VALUES ($1,$2,$3,$4,$5)',
      [now(), userId || null, action || null, target || null, detail ? String(detail).slice(0, 2000) : null]);
  } catch { /* audit is best-effort */ }
}

// ── users / sessions ──────────────────────────────────────────────────────────
async function usersCount()            { return (await q('SELECT COUNT(*)::int AS c FROM users')).rows[0].c; }
async function getUserByUsername(uname) { return (await q('SELECT * FROM users WHERE username=$1', [uname])).rows[0] || null; }
async function getUserById(id)          { return (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0] || null; }
async function insertUser(u) {
  await q(`INSERT INTO users (id,username,display_name,pass_hash,salt,is_admin,org_id,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [u.id, u.username, u.displayName, u.passHash, u.salt, u.isAdmin ? 1 : 0, u.orgId || null, u.createdAt]);
}
async function insertSession(token, userId, createdAt, expiresAt) {
  await q('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES ($1,$2,$3,$4)', [token, userId, createdAt, expiresAt]);
}
async function getSession(token)           { return (await q('SELECT * FROM sessions WHERE token=$1', [token])).rows[0] || null; }
async function deleteSession(token)        { await q('DELETE FROM sessions WHERE token=$1', [token]); }
async function pruneExpiredSessions(nowMs) { await q('DELETE FROM sessions WHERE expires_at < $1', [nowMs]); }
async function touchSession(token, exp)    { await q('UPDATE sessions SET expires_at=$1 WHERE token=$2', [exp, token]); }

// ── RBAC ────────────────────────────────────────────────────────────────────────
const ROLE_RANK = { viewer: 1, reviewer: 2, architect: 3, admin: 4 };
function isRole(r) { return Object.prototype.hasOwnProperty.call(ROLE_RANK, r); }
async function roleFor(userId, projectId) {
  const p = (await q('SELECT user_id FROM projects WHERE id=$1', [projectId])).rows[0];
  if (!p) return null;
  if (p.user_id === userId) return 'admin';
  const m = (await q('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, userId])).rows[0];
  return m ? m.role : null;
}
async function requireAccess(userId, projectId, minRole) {
  const r = await roleFor(userId, projectId);
  if (r == null) throw new Error('project not found');
  if (ROLE_RANK[r] < ROLE_RANK[minRole]) { const e = new Error(`forbidden: this action requires '${minRole}' (you are '${r}')`); e.forbidden = true; throw e; }
  return r;
}

// ── projects ──────────────────────────────────────────────────────────────────
const PROJ_COLS = 'id,user_id,name,description,created_at AS "createdAt",updated_at AS "updatedAt"';
async function projectRow(projectId) {
  return (await q(`SELECT ${PROJ_COLS} FROM projects WHERE id=$1`, [projectId])).rows[0] || null;
}
function shape(p, role, userId) { return p && { id: p.id, name: p.name, description: p.description, createdAt: p.createdAt, updatedAt: p.updatedAt, role, owner: p.user_id === userId, ownerId: p.user_id }; }
async function listProjects(userId) {
  const owned  = (await q(`SELECT ${PROJ_COLS} FROM projects WHERE user_id=$1`, [userId])).rows;
  const shared = (await q(`SELECT p.id,p.user_id,p.name,p.description,p.created_at AS "createdAt",p.updated_at AS "updatedAt", m.role AS role
                           FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.user_id=$1`, [userId])).rows;
  const out = owned.map(p => shape(p, 'admin', userId)).concat(shared.map(p => shape(p, p.role, userId)));
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
async function getProject(userId, projectId) {
  const role = await roleFor(userId, projectId);
  if (!role) return null;
  return shape(await projectRow(projectId), role, userId);
}
async function createProject(userId, { name, description } = {}) {
  const proj = {
    id: newId(),
    name: String(name || 'Untitled project').trim().slice(0, 120) || 'Untitled project',
    description: String(description || '').trim().slice(0, 500),
    createdAt: now(), updatedAt: now(),
  };
  await q('INSERT INTO projects (id,user_id,org_id,name,description,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [proj.id, userId, null, proj.name, proj.description, proj.createdAt, proj.updatedAt]);
  await audit(userId, 'project.create', proj.id, proj.name);
  return { ...proj, role: 'admin', owner: true, ownerId: userId };
}
async function renameProject(userId, projectId, { name, description } = {}) {
  await requireAccess(userId, projectId, 'admin');
  const p = await projectRow(projectId);
  const name2 = name != null ? (String(name).trim().slice(0, 120) || p.name) : p.name;
  const desc2 = description != null ? String(description).trim().slice(0, 500) : p.description;
  await q('UPDATE projects SET name=$1,description=$2,updated_at=$3 WHERE id=$4', [name2, desc2, now(), projectId]);
  await audit(userId, 'project.rename', projectId, name2);
  return shape(await projectRow(projectId), 'admin', userId);
}
async function deleteProject(userId, projectId) {
  if (!(await roleFor(userId, projectId))) return true;
  await requireAccess(userId, projectId, 'admin');
  const p = await projectRow(projectId);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const t of ['drafts', 'conversations', 'stores', 'project_members']) {
      await client.query(`DELETE FROM ${t} WHERE project_id=$1`, [projectId]);
    }
    await client.query('DELETE FROM projects WHERE id=$1', [projectId]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  await audit(userId, 'project.delete', projectId, p && p.name);
  return true;
}
async function touchProject(projectId) { await q('UPDATE projects SET updated_at=$1 WHERE id=$2', [now(), projectId]); }

// ── project members ─────────────────────────────────────────────────────────────
async function listMembers(userId, projectId) {
  await requireAccess(userId, projectId, 'viewer');
  const p = await projectRow(projectId);
  const owner = await getUserById(p.user_id);
  const members = [{ userId: p.user_id, username: owner && owner.username, displayName: owner && owner.display_name, role: 'admin', owner: true }];
  (await q('SELECT m.user_id, m.role, u.username, u.display_name FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1', [projectId])).rows
    .forEach(m => members.push({ userId: m.user_id, username: m.username, displayName: m.display_name, role: m.role, owner: false }));
  return members;
}
async function addMember(userId, projectId, username, role) {
  await requireAccess(userId, projectId, 'admin');
  if (!isRole(role) || role === 'admin') throw new Error('role must be one of: viewer, reviewer, architect');
  const target = await getUserByUsername(String(username || '').trim().toLowerCase());
  if (!target) throw new Error('no such user: ' + username);
  const p = await projectRow(projectId);
  if (target.id === p.user_id) throw new Error('that user is the owner');
  await q(`INSERT INTO project_members (project_id,user_id,role,created_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (project_id,user_id) DO UPDATE SET role=EXCLUDED.role`, [projectId, target.id, role, now()]);
  await audit(userId, 'project.member.add', projectId, `${target.username}:${role}`);
  return { userId: target.id, username: target.username, displayName: target.display_name, role, owner: false };
}
async function setMemberRole(userId, projectId, targetUserId, role) {
  await requireAccess(userId, projectId, 'admin');
  if (!isRole(role) || role === 'admin') throw new Error('role must be one of: viewer, reviewer, architect');
  const r = await q('UPDATE project_members SET role=$1 WHERE project_id=$2 AND user_id=$3', [role, projectId, targetUserId]);
  if (!r.rowCount) throw new Error('not a member');
  await audit(userId, 'project.member.role', projectId, `${targetUserId}:${role}`);
  return true;
}
async function removeMember(userId, projectId, targetUserId) {
  await requireAccess(userId, projectId, 'admin');
  await q('DELETE FROM project_members WHERE project_id=$1 AND user_id=$2', [projectId, targetUserId]);
  await audit(userId, 'project.member.remove', projectId, targetUserId);
  return true;
}

// ── items: drafts / conversations (optimistic concurrency via version) ───────────
const TABLES = { drafts: 'drafts', conversations: 'conversations' };
function itemTable(kind) { const t = TABLES[kind]; if (!t) throw new Error('bad item kind'); return t; }

async function listItems(userId, projectId, kind) {
  await requireAccess(userId, projectId, 'viewer');
  const rows = (await q(`SELECT data FROM ${itemTable(kind)} WHERE project_id=$1 ORDER BY updated_at DESC`, [projectId])).rows;
  return rows.map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
}
async function getItem(userId, projectId, kind, itemId) {
  await requireAccess(userId, projectId, 'viewer');
  const r = (await q(`SELECT data FROM ${itemTable(kind)} WHERE project_id=$1 AND id=$2`, [projectId, itemId])).rows[0];
  if (!r) return null;
  try { return JSON.parse(r.data); } catch { return null; }
}
async function putItem(userId, projectId, kind, itemId, data) {
  await requireAccess(userId, projectId, 'architect');
  const id = String(itemId || newId());
  const existing = (await q(`SELECT data FROM ${itemTable(kind)} WHERE project_id=$1 AND id=$2`, [projectId, id])).rows[0];
  const prev = existing ? (() => { try { return JSON.parse(existing.data); } catch { return {}; } })() : {};
  const { expectedVersion, ...rest } = data || {};
  // optimistic concurrency: reject a stale write so concurrent editors don't clobber each other
  if (expectedVersion != null && prev.version != null && prev.version !== expectedVersion) {
    const e = new Error('conflict: this was updated by someone else — reload before saving'); e.conflict = true; e.currentVersion = prev.version; throw e;
  }
  const merged = { ...prev, ...rest, id, updatedAt: now(), version: (prev.version || 0) + 1 };
  if (!merged.createdAt) merged.createdAt = merged.updatedAt;
  await q(`INSERT INTO ${itemTable(kind)} (id,project_id,data,created_at,updated_at)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (project_id,id) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
    [id, projectId, JSON.stringify(merged), merged.createdAt, merged.updatedAt]);
  await touchProject(projectId);
  return merged;
}
async function deleteItem(userId, projectId, kind, itemId) {
  await requireAccess(userId, projectId, 'architect');
  await q(`DELETE FROM ${itemTable(kind)} WHERE project_id=$1 AND id=$2`, [projectId, itemId]);
  await touchProject(projectId);
  return true;
}

// ── per-project stores ──────────────────────────────────────────────────────────
const STORES_DEFAULT = { connectors: {}, agentcore: {}, cognitiveMemory: {}, finopsConn: null };
async function getStores(userId, projectId) {
  await requireAccess(userId, projectId, 'viewer');
  const r = (await q('SELECT data FROM stores WHERE project_id=$1', [projectId])).rows[0];
  let v = {}; if (r) { try { v = JSON.parse(r.data); } catch {} }
  return { ...STORES_DEFAULT, ...v };
}
async function putStores(userId, projectId, stores) {
  await requireAccess(userId, projectId, 'architect');
  const merged = { ...STORES_DEFAULT, ...(stores || {}) };
  await q(`INSERT INTO stores (project_id,data) VALUES ($1,$2)
           ON CONFLICT (project_id) DO UPDATE SET data=EXCLUDED.data`, [projectId, JSON.stringify(merged)]);
  await touchProject(projectId);
  return merged;
}

module.exports = {
  init, newId, audit,
  usersCount, getUserByUsername, getUserById, insertUser,
  insertSession, getSession, deleteSession, pruneExpiredSessions, touchSession,
  listProjects, getProject, createProject, renameProject, deleteProject,
  listItems, getItem, putItem, deleteItem, getStores, putStores,
  roleFor, listMembers, addMember, setMemberRole, removeMember,
};
