// AgentEye — builder-tool authentication (simple username/password + token sessions).
//
// Hashing stays here (scrypt + per-user salt, timingSafeEqual); persistence moved to
// the SQLite data-access layer (workspace/db.js). Public API is unchanged, so server.js
// routes need no edits.
//
// NOTE: this is the *builder* login — NOT the deploy-time Cognito/Entra/SAML identity
// that generated apps get (a separate AppSpec surface).

const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;   // 30 days

// ── password hashing (scrypt) ───────────────────────────────────────────────
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function verifyPassword(password, salt, expectedHex) {
  const got = Buffer.from(hashPassword(password, salt), 'hex');
  const exp = Buffer.from(String(expectedHex || ''), 'hex');
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}

// public view of a DB user row (never leak pass_hash / salt)
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, displayName: u.display_name, isAdmin: !!u.is_admin, createdAt: u.created_at };
}
const normUsername = s => String(s || '').trim().toLowerCase();

function issueToken(userId) {
  db.pruneExpiredSessions(Date.now());
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.insertSession(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

// ── public API ───────────────────────────────────────────────────────────────
function signup({ username, password, displayName }) {
  const uname = normUsername(username);
  if (!uname || uname.length < 2) throw new Error('username must be at least 2 characters');
  if (!/^[a-z0-9._-]+$/.test(uname)) throw new Error('username may only contain letters, numbers, dot, dash, underscore');
  if (!password || String(password).length < 4) throw new Error('password must be at least 4 characters');
  if (db.getUserByUsername(uname)) throw new Error('that username is already taken');

  const id   = crypto.randomBytes(8).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id, username: uname,
    displayName: String(displayName || username || uname).trim().slice(0, 80) || uname,
    salt, passHash: hashPassword(password, salt),
    isAdmin: db.usersCount() === 0,             // first account is admin
    orgId: null,
    createdAt: new Date().toISOString(),
  };
  db.insertUser(user);
  db.audit(id, 'auth.signup', id, user.username);
  return { token: issueToken(id), user: publicUser(db.getUserById(id)) };
}

function login({ username, password }) {
  const uname = normUsername(username);
  const user = db.getUserByUsername(uname);
  // Run verify even when the user is missing to keep timing roughly uniform.
  const ok = user ? verifyPassword(password, user.salt, user.pass_hash) : verifyPassword(password, 'x', '');
  if (!user || !ok) throw new Error('invalid username or password');
  db.audit(user.id, 'auth.login', user.id, user.username);
  return { token: issueToken(user.id), user: publicUser(user) };
}

function logout(token) {
  if (token) db.deleteSession(token);
}

// Returns userId for a valid, unexpired token, else null. Sliding-window refresh.
function verifyToken(token) {
  if (!token) return null;
  const s = db.getSession(token);
  if (!s) return null;
  if (!s.expires_at || s.expires_at < Date.now()) { db.deleteSession(token); return null; }
  const newExp = Date.now() + SESSION_TTL_MS;
  if (newExp - s.expires_at > 1000 * 60 * 60) db.touchSession(token, newExp);
  return s.user_id;
}

function getUser(userId) { return publicUser(db.getUserById(userId)); }

module.exports = { signup, login, logout, verifyToken, getUser };
