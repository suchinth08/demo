// AgentEye — data-access layer selector.
//
// One swap point for where operational state lives:
//   • DATABASE_URL set  → Postgres (db.pg.js)  — the hosted / SaaS backend (Supabase).
//   • DATABASE_URL unset → SQLite  (db.sqlite.js) — zero-config local default (node:sqlite).
//
// Both backends expose the SAME function surface; the Postgres one is async. Callers
// (workspace/auth.js, workspace/store.js, server.js) `await` every call — and `await`
// on the SQLite backend's synchronous return value is a harmless no-op, so the same
// call sites work against either backend. Always call `await db.init()` once at startup.

const USE_PG = !!process.env.DATABASE_URL;
module.exports = USE_PG ? require('./db.pg') : require('./db.sqlite');
module.exports.BACKEND = USE_PG ? 'postgres' : 'sqlite';
