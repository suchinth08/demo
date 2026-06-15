# Deploying AgentEye — Vercel + Railway + Supabase

AgentEye ships today as a single-process localhost tool. This runbook takes it to
a hosted product. The work is phased; **only P5 (this deploy config) is done and
verifiable now** — P1–P4 are real refactors that need your live accounts/keys.

```
Vercel (static Hub + /assets)  ──HTTPS──▶  Railway (node server.js, API only)
                                            ├─ LLM gateway  (OpenRouter / Anthropic API)   [was: claude -p]
                                            ├─ Supabase Postgres (via pg)                   [was: node:sqlite]
                                            ├─ Supabase Auth (verify JWT)                   [was: scrypt/bearer]
                                            └─ Supabase Storage (generated/ + library/)     [was: local fs]
```

The AWS pieces AgentEye **generates** (a client app's CloudFormation/deploy bundle)
are the *generated artifact's* cloud — independent of where AgentEye itself runs.

---

## Phase status

| Phase | What | Status |
|---|---|---|
| **P5** | Split + deploy config: env-gated CORS/static/host, `vercel.json`, `railway.json`, this runbook | **Done** |
| **P2 (OpenRouter)** | OpenRouter BYO-key adapter — `.env` loader, provider dispatch, transcript replay, cost | **Done — verified end-to-end** |
| **P1** | Postgres backend (selector: `DATABASE_URL`→pg, else sqlite); async `db`/`auth`/`server` | **Done — verified vs live Supabase** |
| P2 (Anthropic) | Optional second adapter via Anthropic SDK (OpenRouter already covers hosted) | Optional |
| P3 | Supabase Auth (verify JWT in `requireAuth`) | Needs Supabase |
| P4 | Supabase Storage for `generated/` + `library/` (Railway fs is ephemeral) | Needs Supabase |

Everything in P5 is **additive and env-gated**: with no env vars set, AgentEye runs
exactly as before on localhost.

---

## The one hard constraint: `claude -p` can't run on Railway

Locally, AgentEye spawns your logged-in `claude -p` for each turn. There is no
Claude Code login inside a container, so the hosted backend **must** call an API
provider instead. AgentEye now has a provider seam (`LLM_PROVIDER`):

- `claude-cli` *(default)* — the local CLI. Localhost only.
- `openrouter` — OpenRouter's OpenAI-compatible API with **your** `OPENROUTER_API_KEY`
  (BYO-key). Reaches Claude, GPT, Llama, etc. through one key.
- `anthropic` — the Anthropic API directly with `ANTHROPIC_API_KEY`.

The **`openrouter` adapter is built and verified** — it loads `OPENROUTER_API_KEY`
(from `.env` via `process.loadEnvFile`, or the Railway dashboard), routes per task
(Sonnet for chat/preview, Haiku for suggest/gist), forwards a bounded in-memory
transcript each turn for multi-turn continuity (the API has no `--resume`), caps
output via `OPENROUTER_MAX_TOKENS` (default 8192), and reports per-turn cost. The
`anthropic` adapter is an optional second backend (not yet wired — OpenRouter
already covers the hosted need). The `claude-cli` default is unchanged for local use.

> **Credit note:** OpenRouter reserves headroom for the *max* output, and AgentEye's
> system prompts are large — a near-empty free balance returns `402`. A few dollars
> of credit (or lowering `OPENROUTER_MAX_TOKENS`) clears it.
> **Cost note:** each builder turn now bills per-token (~$0.01/turn on Sonnet in
> testing) instead of riding a Claude Code subscription. C1 routing keeps cheap
> tasks on Haiku.

---

## P5 — what's wired now

### Railway (backend, API-only)
1. New project → Deploy from this repo. `railway.json` sets the start command
   (`node server.js`) and a `/health` check; Nixpacks builds Node ≥ 22.5.
2. Set service variables (see `.env.example`):
   - `HOST=0.0.0.0` — **required** so the container is reachable (default binds localhost-only).
   - `SERVE_STATIC=false` — Vercel serves the Hub; this process is API-only.
   - `CORS_ORIGIN=https://<your-app>.vercel.app` — lock the API to your frontend.
   - `LLM_PROVIDER=openrouter` + `OPENROUTER_API_KEY` — the working hosted LLM path.
   - `DATABASE_URL` — the Supabase **pooler** string (session mode, 5432) for Postgres.
3. Copy the public Railway URL (e.g. `agenteye-production.up.railway.app`).

### Vercel (frontend, static)
1. New project → import this repo. `vercel.json` serves `AgentEye_Hub.html` at `/`
   and **rewrites every API path to Railway**, so the Hub's relative `fetch()`
   calls stay same-origin (no CORS, no code change).
2. **Edit `vercel.json`**: replace `RAILWAY_API_URL` with your Railway host
   (Vercel does not interpolate env vars into rewrite destinations — the literal
   URL must be committed).
3. Deploy. The Hub loads from Vercel; `/chat`, `/projects`, `/app/*`, etc. proxy
   to Railway.

### Verify P5 locally (no accounts needed)
```bash
SERVE_STATIC=false CORS_ORIGIN=https://example.vercel.app PORT=7899 node server.js
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7899/          # not 200 (HTML not served)
curl -si http://127.0.0.1:7899/health | grep -i access-control-allow-origin  # = the locked origin
```

---

## Phase notes

- **P1 (Postgres) — DONE.** `workspace/db.js` is now a selector: `DATABASE_URL` set →
  `db.pg.js` (Postgres via `pg`), unset → `db.sqlite.js` (the zero-config local default).
  `auth.js` is async and `await` propagates through `server.js`. Verified against live
  Supabase: full RBAC + optimistic-concurrency + members + stores + delete (16/16).
  **Use the pooler string** (Connect → Session mode, port 5432) — the direct
  `db.<ref>.supabase.co` host is IPv6-only and won't resolve on IPv4 / Railway.
- **P2 (OpenRouter) — DONE** (see above).
- **P3 (Auth):** `SUPABASE_JWT_SECRET`. The login overlay calls Supabase
  sign-in/up; `requireAuth` verifies the Supabase JWT.
- **P4 (Storage):** a Supabase Storage bucket. `generated/` + `library/` write to
  object storage instead of the ephemeral container fs; `/app/assets/*` reads from it.

---

## Notes
- Keep `.env` and `.auth/` out of git (already gitignored).
- Provider keys / connector secrets are stored as references, never raw — same rule
  end to end.
- "Axiom" (from the original ask) is an observability/logging tool, not an auth
  provider — auth is Supabase Auth. Axiom can ingest Railway logs later if wanted.
