#!/usr/bin/env node
// AgentEye bridge — exposes the local `claude` CLI (Claude Code) to the
// AgentEye_Hub.html UI so the browser can talk to your already-authenticated
// Claude Code session instead of hitting api.anthropic.com directly.
//
//   node server.js                    → http://localhost:7860
//   PORT=8080 node server.js          → http://localhost:8080
//
// Requires:  `claude` on PATH (npm install -g @anthropic-ai/claude-code)
//            AND a logged-in Claude Code session on this machine.

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT       = parseInt(process.env.PORT, 10) || 7860;
const ROOT       = __dirname;
const HTML_FILE  = path.join(ROOT, 'AgentEye_Hub.html');
const PROMPT_DIR = path.join(ROOT, '.agenteye_prompts');
const PROVISION_PROMPT_PATH = path.join(PROMPT_DIR, 'provision.txt');
const PREVIEW_PROMPT_PATH   = path.join(PROMPT_DIR, 'preview.txt');
const SUGGEST_PROMPT_PATH   = path.join(PROMPT_DIR, 'suggest.txt');
const GIST_PROMPT_PATH      = path.join(PROMPT_DIR, 'gist.txt');
const FORK_PROMPT_PATH      = path.join(PROMPT_DIR, 'fork.txt');
const LIBRARY_DIR           = path.join(ROOT, 'library');
let GIT_AVAILABLE = false;
const isWin = process.platform === 'win32';

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPT — the provisioning agent personality
// ─────────────────────────────────────────────────────────────────────────────
const PROVISION_PROMPT = `You are AgentEye — an expert AWS Bedrock Agent architect and a warm, friendly provisioning guide. Your job is to help non-technical business users design and configure a complete, production-ready AWS Bedrock Agent through natural conversation — one clear question at a time.

STAGES (progress in order):
1. USE_CASE — What problem does the agent solve? Who uses it? What outcomes does it drive?
   ALSO during USE_CASE: ask whether this should be a single SPECIALIST agent (handles everything itself) or a SUPERVISOR agent (orchestrates and routes to a team of specialist sub-agents). Set "agentMode" accordingly. If they say supervisor, mention that they'll be able to pick collaborators from their existing Library at the TOOLS stage.
2. PERSONA — Agent name, role title, behavioral personality, tone of voice
3. MODEL — Foundation model selection (default recommendation: Claude Sonnet 4 for most cases; Haiku 4.5 for cost-sensitive; Opus 4.7 for complex reasoning)
4. KNOWLEDGE — Knowledge bases needed: documents, databases, S3 data, product catalogs, FAQs.
   IF agentMode is "supervisor": SKIP this stage. Supervisors don't have their own knowledge base; their specialists do. Set knowledgeBases to [] and move directly to TOOLS.
5. TOOLS — For specialists: action groups (Lambdas, calculations, lookups) + MCP connectors (Salesforce, Jira, Confluence, Slack, SAP, databases, custom REST APIs).
   For supervisors: this stage is about COLLABORATORS instead. Ask the user what kinds of specialists they need; remind them to pick concrete agents from their Library via the "Pick from Library" button in the side panel. The picked entries will populate the "collaborators" array client-side; on the next turn you'll see them filled in. You may also still capture supervisor-level action groups if they want any (rare).
6. GUARDRAILS — Content safety, topic restrictions, PII handling (anonymize vs block), denied topics
7. MEMORY — Cognitive memory architecture. Ask succinctly about each tier the agent should have, with a one-line explanation each:
   - WORKING memory (in-turn scratchpad — what the agent reasons about right now; not persisted)
   - SEMANTIC memory (durable facts/entities/concepts — vector-indexed, survives every session)
   - PROCEDURAL memory (learned how-to runbooks the agent re-uses on similar tasks)
   - EPISODIC memory (timestamped event log + per-session recaps)
   For each enabled tier, capture the headline setting: write policy + PII strategy for semantic; authoring mode for procedural; retention + auto-recap for episodic; scratchpad format for working. Bundle 2–3 related questions per turn so this doesn't drag on. Always emit the populated tiers under "cognitiveMemory" in agentConfig (see schema below); also keep the existing memory.sessionSummary/storageDays for backwards compatibility.
8. ENTERPRISE — Enterprise hardening: ask succinct questions about (a) NETWORK posture (public / VPC endpoints / PrivateLink only — for regulated workloads default to PrivateLink), (b) ENCRYPTION (AWS-managed default, or customer-managed KMS key — capture the KMS key ARN if provided), (c) HUMAN-IN-THE-LOOP APPROVALS for destructive actions (none / for writes only / for everything), (d) OBSERVABILITY (CloudWatch logs default, plus optional X-Ray tracing and an external collector endpoint), (e) COST ALLOCATION TAGS (offer a sensible default set: Project, Environment, Owner, CostCenter — let the user override values), (f) DISASTER RECOVERY posture (single region / active-passive / active-active) including primary and secondary regions, (g) PER-AGENT QUOTAS (off / requests-per-minute cap). Be brisk here — bundle 2–3 related questions per turn so this doesn't take 7 round trips. Skip sensibly when the user signals "use defaults".
9. COMPLETE — All configured. Write a detailed, comprehensive instruction prompt for the agent.
   FOR SUPERVISORS: the instruction MUST include an explicit "Routing rules" section that, for each entry in collaborators[], states a one-line rule like 'Route to "<agentName>" when the user asks about <topic>'. Also populate collaborators[i].routingRule with the same one-liner.

RULES:
- Ask ONE focused question at a time, in plain business language (no AWS jargon)
- Translate technical concepts: say "data sources the agent can look up" not "vector knowledge base embeddings"
- Be warm and measured (mirror Claude's tone — calm, clear, never effusive)
- Proactively suggest smart defaults: "For a customer support bot, I'd recommend content filtering on and PII anonymization — shall I set those up?"
- Probe deeply on TOOLS stage: ask if they need to integrate with CRMs, ticketing systems, databases, file systems, external APIs
- At COMPLETE stage, write a rich, detailed multi-paragraph system instruction that captures: agent identity, role, capabilities, constraints, tone, how it should handle edge cases
- Keep responses concise — one short paragraph max, then the question
- Do NOT use any tools, do NOT read files, do NOT run shell commands. Your only job is to converse and emit JSON.
- ALWAYS echo back agentMode and collaborators[] on every turn once they are set, so the UI keeps showing them.
- The "enterprise" object, once set, must look like:
  {
    "network":      { "mode": "public" | "vpcEndpoints" | "privateLinkOnly", "vpcId": "...", "subnetIds": ["..."], "securityGroupIds": ["..."] },
    "encryption":   { "mode": "aws-managed" | "customer-managed", "kmsKeyArn": "..." },
    "approvals":    { "mode": "none" | "writes-only" | "all-actions", "approverGroupArn": "..." },
    "observability":{ "cloudwatchLogs": true, "xrayTracing": true|false, "externalCollectorUrl": "..." },
    "tags":         { "Project": "...", "Environment": "...", "Owner": "...", "CostCenter": "..." },
    "dr":           { "posture": "single-region" | "active-passive" | "active-active", "primaryRegion": "...", "secondaryRegion": "..." },
    "quotas":       { "perAgentRpm": null | <integer> }
  }
  Echo this on every turn once any field is set; only fill the keys you've gathered, leave the rest at null/empty.

ALWAYS respond in this EXACT JSON format. No markdown fences, no extra text, just raw valid JSON:
{
  "message": "Your friendly response + next question",
  "stage": "USE_CASE",
  "agentConfig": {
    "name": null,
    "description": null,
    "useCase": null,
    "targetUsers": null,
    "agentMode": null,
    "foundationModel": null,
    "instruction": null,
    "knowledgeBases": [],
    "actionGroups": [],
    "mcpConnectors": [],
    "collaborators": [],
    "guardrails": null,
    "memory": null,
    "cognitiveMemory": null,
    "enterprise": null
  },
  // cognitiveMemory shape (only include the tiers that are turned on):
  //   {
  //     "working":    { "enabled": true, "mode": "...", "maxTokens": "2000", "showToUser": "collapsed", "planFormat": "markdown checklist" },
  //     "semantic":   { "enabled": true, "storeName": "...", "embeddingModel": "amazon.titan-embed-text-v2:0", "retentionDays": "180", "piiStrategy": "anonymize", "writePolicy": "user-confirmed", "topK": "8" },
  //     "procedural": { "enabled": true, "bucket": "...", "prefix": "runbooks/", "authoring": "hybrid", "approvalRequired": "any human", "maxRunbookSize": "24", "recallStrategy": "similarity-search" },
  //     "episodic":   { "enabled": true, "storeName": "...", "eventTypes": "+ tool calls", "retentionDays": "30", "recapOnSessionEnd": "on", "piiStrategy": "mask", "replayable": "yes" }
  //   },
  "readyToGenerate": false
}

Only include fields you've determined — leave undetermined fields as null or [].
Set readyToGenerate: true only when stage is COMPLETE and instruction is fully written.`;

const PREVIEW_SUFFIX = `

[PREVIEW MODE: You are now responding AS this agent in a sandbox. Knowledge bases and action groups are simulated — when an action would be invoked, describe what you would do and what the response would look like, in plain prose. Do NOT use any tools, do NOT read files, do NOT run shell commands. Just chat as the agent would.]`;

// ─────────────────────────────────────────────────────────────────────────────
// Boot — write prompt files
// ─────────────────────────────────────────────────────────────────────────────
const SUGGEST_PROMPT = `You are a configuration assistant. The user will give you a JSON-shaped request describing a connector or component they need defaults for. Respond ONLY with raw, valid JSON — no markdown fences, no prose, no preamble. The JSON must have exactly the keys the user lists. For credentials and secrets, return placeholder AWS Secrets Manager ARN strings ("arn:aws:secretsmanager:us-east-1:ACCOUNT:secret:..."). Never invent real credentials. Do NOT use any tools, do NOT read files, do NOT run shell commands.`;

const GIST_PROMPT = `Summarize this AWS Bedrock agent for a project library entry. Two to four sentences. State plainly what it does, who uses it, and the key technical pieces — foundation model plus a couple of representative tools or connectors. No headings, no bullet points, no markdown formatting, no preamble like "This agent…"; just a clear paragraph that another developer would skim to decide whether to fork from this version.`;

if (!fs.existsSync(PROMPT_DIR)) fs.mkdirSync(PROMPT_DIR, { recursive: true });
fs.writeFileSync(PROVISION_PROMPT_PATH, PROVISION_PROMPT, 'utf8');
fs.writeFileSync(SUGGEST_PROMPT_PATH,   SUGGEST_PROMPT,   'utf8');
fs.writeFileSync(GIST_PROMPT_PATH,      GIST_PROMPT,      'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Spawn `claude -p` and return parsed JSON
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || 600000;  // 10 min

function callClaude({ message, sessionId, systemPromptPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--system-prompt-file', systemPromptPath,
    ];
    if (sessionId) args.push('--resume', sessionId);

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,            // claude.cmd on Windows needs cmd shell
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const killer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGTERM'); } catch (e) {}
      reject(new Error(`claude -p timed out after ${Math.round(timeoutMs/1000)}s`));
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
    proc.on('error', err => { clearTimeout(killer); reject(new Error(`spawn failed: ${err.message}. Is the 'claude' CLI on PATH?`)); });
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (killed) return;
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}\nstderr: ${stderr.trim()}\nstdout: ${stdout.trim().slice(0, 400)}`));
      }
      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (e) {
        reject(new Error(`could not parse claude JSON output: ${e.message}\nstdout: ${stdout.slice(0, 800)}\nstderr: ${stderr.slice(0, 400)}`));
      }
    });

    proc.stdin.write(message);
    proc.stdin.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Library — Git-backed Markdown record of every published agent
// ─────────────────────────────────────────────────────────────────────────────
function gitCheck() {
  return new Promise(resolve => {
    let ok = false;
    const proc = spawn('git', ['--version'], { shell: isWin, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    proc.on('error', () => resolve(false));
    proc.stdout.on('data', () => { ok = true; });
    proc.on('close', code => resolve(ok && code === 0));
  });
}
function git(args, cwd = LIBRARY_DIR) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, shell: isWin, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(' ')} (exit ${code}): ${stderr.trim()}`)));
  });
}
async function ensureLibrary() {
  if (!fs.existsSync(LIBRARY_DIR)) fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  GIT_AVAILABLE = await gitCheck();
  if (!GIT_AVAILABLE) {
    console.warn('  [warn] git not on PATH — library will work but without commit history.');
    return;
  }
  if (!fs.existsSync(path.join(LIBRARY_DIR, '.git'))) {
    try {
      await git(['init', '-b', 'main']);
      try { await git(['config', 'user.email', 'agenteye@local']); } catch {}
      try { await git(['config', 'user.name',  'AgentEye']); } catch {}
      fs.writeFileSync(path.join(LIBRARY_DIR, '.gitignore'), '.commit-msg\n.tmp/\n');
      fs.writeFileSync(path.join(LIBRARY_DIR, 'README.md'),
        `# AgentEye Library\n\nVersioned, Git-backed record of agents provisioned through AgentEye.\nEach commit captures one publish: transcript, agent config (md), CloudFormation YAML, connector wiring, and an auto-generated gist.\n`);
      await git(['add', '.gitignore', 'README.md']);
      await git(['commit', '-m', 'Init']);
      console.log('  [ok]   library/ initialised as a fresh Git repo');
    } catch (e) {
      console.warn('  [warn] library/ git init failed:', e.message);
      GIT_AVAILABLE = false;
    }
  }
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}
function safePart(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, ''); }

function buildAgentMd(a) {
  const out = [`# ${a.name || 'Unnamed agent'}`, ''];
  out.push(`**Use case:** ${a.useCase || '—'}  `);
  out.push(`**Target users:** ${a.targetUsers || '—'}  `);
  out.push(`**Foundation model:** \`${a.foundationModel || '—'}\``);
  out.push('', '## Description', '', a.description || '_(none)_', '', '## Instruction', '', a.instruction || '_(none)_', '');
  if (a.knowledgeBases?.length) { out.push('## Knowledge bases', ''); a.knowledgeBases.forEach(k => out.push(`- **${k.name}** — ${k.description || ''}`)); out.push(''); }
  if (a.actionGroups?.length)   { out.push('## Action groups', '');   a.actionGroups.forEach(g => out.push(`- **${g.name}** — ${g.description || ''}`)); out.push(''); }
  if (a.mcpConnectors?.length)  { out.push('## MCP connectors', '');  a.mcpConnectors.forEach(c => out.push(`- **${c.name}** _(${c.type || 'mcp'})_ — ${c.description || ''}`)); out.push(''); }
  if (a.guardrails) {
    out.push('## Guardrails', '');
    if (a.guardrails.contentFiltering) out.push('- Content filtering enabled');
    if (a.guardrails.piiHandling)      out.push(`- PII handling: ${a.guardrails.piiHandling}`);
    if (a.guardrails.topics?.length)   out.push(`- Denied topics: ${a.guardrails.topics.join(', ')}`);
    out.push('');
  }
  if (a.memory) {
    out.push('## Memory', '');
    if (a.memory.sessionSummary) out.push('- Session summary enabled');
    if (a.memory.storageDays)    out.push(`- Retention: ${a.memory.storageDays} days`);
    out.push('');
  }
  if (a.cognitiveMemory) {
    const tiers = ['working','semantic','procedural','episodic'].filter(k => a.cognitiveMemory[k]?.enabled);
    if (tiers.length) {
      out.push('## Cognitive memory', '');
      out.push(`Tiers enabled: **${tiers.join(' · ')}**`, '');
      tiers.forEach(t => {
        const sub = a.cognitiveMemory[t];
        out.push(`### ${t.charAt(0).toUpperCase() + t.slice(1)}`, '');
        Object.entries(sub).forEach(([k,v]) => { if (k !== 'enabled' && v != null && v !== '') out.push(`- ${k}: \`${v}\``); });
        out.push('');
      });
    }
  }
  return out.join('\n');
}

const VAULT_PROTOCOL_DEFAULT = `# Memory protocol

This vault holds the agent's long-term memory under four tiers:

- **working/** — in-turn scratchpad; cleared per session.
- **semantic/** — durable facts, entities, concepts (the "what is true").
- **procedural/** — learned runbooks the agent re-uses on similar tasks (the "how").
- **episodic/** — timestamped session logs + distilled recaps.

The agent reads BEFORE reasoning, writes AFTER acting, and cites every recall.
`;

function buildVaultScaffold(slugDir, version, cognitiveMemory, memoryProtocolText) {
  if (!cognitiveMemory) return;
  const enabled = ['working','semantic','procedural','episodic'].filter(k => cognitiveMemory[k]?.enabled);
  if (!enabled.length) return;
  const memDir = path.join(slugDir, version, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'README.md'),
    `# Memory vault — ${path.basename(slugDir)} ${version}\n\nTiers enabled: **${enabled.join(' · ')}**\n\n` + VAULT_PROTOCOL_DEFAULT);
  fs.writeFileSync(path.join(memDir, 'PROTOCOL.md'), memoryProtocolText && memoryProtocolText.trim() ? memoryProtocolText : VAULT_PROTOCOL_DEFAULT);

  if (cognitiveMemory.working?.enabled) {
    const d = path.join(memDir, 'working'); fs.mkdirSync(d, { recursive: true });
    const fmt = cognitiveMemory.working.planFormat || 'markdown checklist';
    fs.writeFileSync(path.join(d, '_template.md'),
      `---\ntype: scratchpad\nformat: ${fmt}\n---\n\n# Working scratchpad\n\n## Plan\n- [ ] \n\n## Decisions so far\n_(agent appends one-liners as it commits to actions)_\n`);
  }
  if (cognitiveMemory.semantic?.enabled) {
    const d = path.join(memDir, 'semantic');
    fs.mkdirSync(path.join(d, 'entities'),  { recursive: true });
    fs.mkdirSync(path.join(d, 'concepts'),  { recursive: true });
    fs.writeFileSync(path.join(d, 'INDEX.md'),
      `# Semantic memory index\n\nDurable facts the agent has learned. One file per entity or concept.\nUse \`[[wikilinks]]\` to cross-reference between files.\n\n## Entities\n_(none yet — populated by agent recap or human curation)_\n\n## Concepts\n_(none yet)_\n`);
    fs.writeFileSync(path.join(d, 'entities', '_template.md'),
      `---\ntype: entity\nname: <Entity Name>\naliases: []\nconfidence: medium\nlast_seen: \nsources: []\n---\n\n# <Entity Name>\n\n_Two- to four-line summary the agent will recall._\n\n## Related\n- [[../concepts/...]]\n`);
  }
  if (cognitiveMemory.procedural?.enabled) {
    const d = path.join(memDir, 'procedural');
    fs.mkdirSync(path.join(d, 'runbooks'), { recursive: true });
    fs.writeFileSync(path.join(d, 'INDEX.md'),
      `# Procedural memory — runbook index\n\nTitle-only index for cheap recall. The agent loads the full runbook body ONLY when it commits to executing it.\n\n## Runbooks\n_(none yet)_\n`);
    fs.writeFileSync(path.join(d, 'runbooks', '_template.md'),
      `---\ntype: runbook\ntitle: <One-line task statement>\npreconditions: []\nestimated_minutes: \nlast_success: \nauthor: \napproved_by: \n---\n\n# <Title>\n\n## When to use\n_One paragraph: what task this solves and how to recognise it._\n\n## Steps\n1. \n2. \n\n## Verification\n- \n\n## Rollback\n- \n`);
  }
  if (cognitiveMemory.episodic?.enabled) {
    const d = path.join(memDir, 'episodic');
    fs.mkdirSync(path.join(d, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(d, 'recaps'),   { recursive: true });
    fs.writeFileSync(path.join(d, 'INDEX.md'),
      `# Episodic memory\n\nAppend-only event log per session, plus distilled recaps.\n\n## Sessions\n_(Session-Log-YYYY-MM-DD.md files land here)_\n\n## Recaps\n_(3–5 line recaps land here after session end)_\n`);
  }
}
function buildTranscriptMd(transcript, agentName) {
  const out = [`# ${agentName || 'Agent'} — Provisioning Transcript`, '', `_Captured ${new Date().toISOString()}_`, '', '---', ''];
  (transcript || []).forEach(m => {
    out.push(`#### ${m.role === 'user' ? 'You' : 'AgentEye'}`, '', m.content, '');
  });
  return out.join('\n');
}
function buildConnectorsYaml(connectorValues) {
  if (!connectorValues || !Object.keys(connectorValues).length) return '';
  const lines = ['# Connector wiring captured at publish time', '# Secret values are AWS Secrets Manager ARN references only — no raw credentials.', ''];
  Object.entries(connectorValues).forEach(([id, vals]) => {
    lines.push(`${id}:`);
    Object.entries(vals || {}).forEach(([k, v]) => {
      if (v == null || v === '') return;
      const s = String(v);
      const safe = /^[a-zA-Z0-9._/:-]+$/.test(s) && !s.includes('\n') ? s : JSON.stringify(s);
      lines.push(`  ${k}: ${safe}`);
    });
    lines.push('');
  });
  return lines.join('\n');
}

async function generateGist(agent) {
  const message = `Agent JSON:\n${JSON.stringify(agent, null, 2)}`;
  const result = await callClaude({ message, sessionId: null, systemPromptPath: GIST_PROMPT_PATH, timeoutMs: 90000 });
  return (result.result || '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP routing
// ─────────────────────────────────────────────────────────────────────────────
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5_000_000) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Permissive CORS — bridge only listens on 127.0.0.1
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET / → serve UI ──
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/AgentEye_Hub.html')) {
    fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('AgentEye_Hub.html not found beside server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  // ── GET /health → readiness probe ──
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJSON(res, 200, { ok: true, bridge: 'claude-cli', port: PORT });
  }

  // ── POST /chat → provisioner conversation ──
  if (req.method === 'POST' && url.pathname === '/chat') {
    try {
      const body = await readBody(req);
      const { message, sessionId } = JSON.parse(body || '{}');
      if (!message || typeof message !== 'string') return sendJSON(res, 400, { ok: false, error: 'message required' });

      const result = await callClaude({
        message,
        sessionId: sessionId || null,
        systemPromptPath: PROVISION_PROMPT_PATH,
      });
      return sendJSON(res, 200, {
        ok: true,
        rawResult: result.result || '',
        sessionId: result.session_id || sessionId || null,
        costUsd:   result.total_cost_usd || 0,
        durationMs: result.duration_ms || 0,
      });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ── POST /preview → chat with the configured agent (Test tab) ──
  if (req.method === 'POST' && url.pathname === '/preview') {
    try {
      const body = await readBody(req);
      const { message, sessionId, instruction, agentName } = JSON.parse(body || '{}');
      if (!message || typeof message !== 'string') return sendJSON(res, 400, { ok: false, error: 'message required' });
      if (!instruction || typeof instruction !== 'string') return sendJSON(res, 400, { ok: false, error: 'instruction required' });

      // Refresh the preview prompt each call so it tracks edits to the agent.
      const previewPrompt = (agentName ? `You are "${agentName}". ` : '') + instruction + PREVIEW_SUFFIX;
      fs.writeFileSync(PREVIEW_PROMPT_PATH, previewPrompt, 'utf8');

      const result = await callClaude({
        message,
        sessionId: sessionId || null,
        systemPromptPath: PREVIEW_PROMPT_PATH,
      });
      return sendJSON(res, 200, {
        ok: true,
        message: result.result || '',
        sessionId: result.session_id || sessionId || null,
      });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ── POST /publish → write versioned bundle into library/ + git commit ──
  if (req.method === 'POST' && url.pathname === '/publish') {
    try {
      const body = await readBody(req);
      const { agent, transcript, connectorValues, cognitiveMemory, memoryProtocol, author, message } = JSON.parse(body || '{}');
      if (!agent || !agent.name) return sendJSON(res, 400, { ok: false, error: 'agent.name required' });

      const slug = slugify(agent.name);
      if (!slug) return sendJSON(res, 400, { ok: false, error: 'agent.name produced an empty slug' });
      const slugDir = path.join(LIBRARY_DIR, slug);
      if (!fs.existsSync(slugDir)) fs.mkdirSync(slugDir, { recursive: true });
      const existing = fs.readdirSync(slugDir).filter(d => /^v\d+$/.test(d)).map(d => parseInt(d.slice(1), 10));
      const nextVer = (existing.length ? Math.max(...existing) : 0) + 1;
      const version = 'v' + String(nextVer).padStart(3, '0');
      const verDir = path.join(slugDir, version);
      fs.mkdirSync(verDir);

      // gist generation may take ~5–15s — run before writing the rest so we can include it in the same commit
      let gist = '';
      try { gist = await generateGist(agent); }
      catch (e) { gist = `_(gist generation failed: ${e.message.slice(0, 200)})_`; }

      // Ensure cognitiveMemory is preserved on the agent payload so buildAgentMd renders it.
      if (cognitiveMemory && !agent.cognitiveMemory) agent.cognitiveMemory = cognitiveMemory;

      fs.writeFileSync(path.join(verDir, 'agent.md'),       buildAgentMd(agent));
      fs.writeFileSync(path.join(verDir, 'transcript.md'),  buildTranscriptMd(transcript, agent.name));
      fs.writeFileSync(path.join(verDir, 'gist.md'),        gist);
      const cfgYaml = buildConnectorsYaml(connectorValues);
      if (cfgYaml) fs.writeFileSync(path.join(verDir, 'connectors.yaml'), cfgYaml);

      // Cognitive memory: scaffold the Obsidian-style vault under memory/.
      try { buildVaultScaffold(slugDir, version, cognitiveMemory || agent.cognitiveMemory, memoryProtocol); }
      catch (e) { console.warn('  [warn] vault scaffold failed:', e.message); }

      const meta = {
        slug, version, agentName: agent.name,
        useCase: agent.useCase || null,
        targetUsers: agent.targetUsers || null,
        foundationModel: agent.foundationModel || null,
        author: author || null,
        timestamp: new Date().toISOString(),
        counts: {
          knowledgeBases: (agent.knowledgeBases || []).length,
          actionGroups:   (agent.actionGroups   || []).length,
          mcpConnectors:  (agent.mcpConnectors  || []).length,
        },
        agent,                                  // full snapshot for cheap forking
      };
      fs.writeFileSync(path.join(verDir, 'meta.json'), JSON.stringify(meta, null, 2));

      let commitHash = null;
      if (GIT_AVAILABLE) {
        try {
          const rel = path.relative(LIBRARY_DIR, verDir).replace(/\\/g, '/');
          await git(['add', rel]);
          const msgFile = path.join(LIBRARY_DIR, '.commit-msg');
          // Author info embedded in commit body — dodges shell:true argv-tokenization
          // problems on Windows where "Name <email>" gets re-split by cmd.exe.
          const subject = (message && String(message).trim() ? message : `Publish ${slug} ${version}`).replace(/\n/g, ' ').slice(0, 200);
          const authorLine = author ? `\n\nAuthor: ${author}` : '';
          fs.writeFileSync(msgFile, subject + authorLine + '\n');
          try {
            await git(['commit', '-F', msgFile]);
            commitHash = (await git(['rev-parse', 'HEAD'])).trim();
          } finally {
            if (fs.existsSync(msgFile)) fs.unlinkSync(msgFile);
          }
        } catch (e) {
          console.warn('  [warn] git commit failed:', e.message);
        }
      }
      return sendJSON(res, 200, { ok: true, slug, version, hash: commitHash, gist, meta });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ── GET /library → list every {slug, version} bundle (newest first) ──
  if (req.method === 'GET' && url.pathname === '/library') {
    try {
      if (!fs.existsSync(LIBRARY_DIR)) return sendJSON(res, 200, { ok: true, items: [], git: GIT_AVAILABLE });
      const items = [];
      const slugs = fs.readdirSync(LIBRARY_DIR).filter(s => {
        if (s.startsWith('.') || s === 'README.md') return false;
        try { return fs.statSync(path.join(LIBRARY_DIR, s)).isDirectory(); } catch { return false; }
      });
      slugs.forEach(slug => {
        const slugDir = path.join(LIBRARY_DIR, slug);
        const versions = fs.readdirSync(slugDir).filter(d => /^v\d+$/.test(d)).sort().reverse();
        versions.forEach(version => {
          const verDir = path.join(slugDir, version);
          let meta = {};
          try { meta = JSON.parse(fs.readFileSync(path.join(verDir, 'meta.json'), 'utf8')); } catch {}
          let gist = '';
          try { gist = fs.readFileSync(path.join(verDir, 'gist.md'), 'utf8').trim(); } catch {}
          items.push({ slug, version, gist, ...meta, agent: undefined }); // strip full agent from list response
        });
      });
      items.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      return sendJSON(res, 200, { ok: true, items, git: GIT_AVAILABLE });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ── GET /library/:slug/:version → full bundle ──
  if (req.method === 'GET' && url.pathname.startsWith('/library/')) {
    try {
      const parts = url.pathname.replace(/^\/library\//, '').split('/').filter(Boolean).map(safePart);
      if (parts.length !== 2) return sendJSON(res, 400, { ok: false, error: 'expected /library/<slug>/<version>' });
      const verDir = path.join(LIBRARY_DIR, parts[0], parts[1]);
      if (!verDir.startsWith(LIBRARY_DIR + path.sep) || !fs.existsSync(verDir)) return sendJSON(res, 404, { ok: false, error: 'not found' });
      const read = name => { try { return fs.readFileSync(path.join(verDir, name), 'utf8'); } catch { return null; } };
      let meta = {};
      try { meta = JSON.parse(read('meta.json') || '{}'); } catch {}
      return sendJSON(res, 200, {
        ok: true,
        meta,
        agentMd:        read('agent.md'),
        transcriptMd:   read('transcript.md'),
        gistMd:         read('gist.md'),
        connectorsYaml: read('connectors.yaml'),
      });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ── POST /fork-chat → conversation seeded with a prior agent's full state ──
  if (req.method === 'POST' && url.pathname === '/fork-chat') {
    try {
      const body = await readBody(req);
      const { message, sessionId, priorAgent } = JSON.parse(body || '{}');
      if (!message)     return sendJSON(res, 400, { ok: false, error: 'message required' });
      if (!priorAgent)  return sendJSON(res, 400, { ok: false, error: 'priorAgent required' });

      // Regenerate fork prompt every call (cheap, idempotent) so any user-side edits to priorAgent take effect.
      const forkPrompt = `${PROVISION_PROMPT}

[FORK CONTEXT — IMPORTANT]
The user is iterating on an EXISTING agent. The full prior agentConfig is below. Treat every populated field as the CURRENT state and DO NOT re-ask questions whose answers are already filled. Echo back the prior values inside agentConfig on every turn (so the UI keeps showing them) and update only the fields the user is changing. Set "stage" to whatever step they're now editing. Stay in COMPLETE if they're tweaking instruction/guardrails/memory rather than reshaping the agent.

PRIOR AGENT (current state — preserve these on every turn unless edited):
${JSON.stringify(priorAgent, null, 2)}`;
      fs.writeFileSync(FORK_PROMPT_PATH, forkPrompt, 'utf8');

      const result = await callClaude({ message, sessionId: sessionId || null, systemPromptPath: FORK_PROMPT_PATH });
      return sendJSON(res, 200, {
        ok: true,
        rawResult: result.result || '',
        sessionId: result.session_id || sessionId || null,
      });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ── POST /suggest → one-shot utility call (no session, JSON-only system prompt) ──
  if (req.method === 'POST' && url.pathname === '/suggest') {
    try {
      const body = await readBody(req);
      const { prompt } = JSON.parse(body || '{}');
      if (!prompt || typeof prompt !== 'string') return sendJSON(res, 400, { ok: false, error: 'prompt required' });
      const result = await callClaude({
        message: prompt,
        sessionId: null,
        systemPromptPath: SUGGEST_PROMPT_PATH,
      });
      return sendJSON(res, 200, { ok: true, raw: result.result || '' });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ── POST /memory/recap → distill a transcript into a 3-5 line episodic recap ──
  if (req.method === 'POST' && url.pathname === '/memory/recap') {
    try {
      const body = await readBody(req);
      const { transcript, agentName } = JSON.parse(body || '{}');
      if (!Array.isArray(transcript) || !transcript.length) return sendJSON(res, 400, { ok: false, error: 'transcript array required' });
      const recapPromptPath = path.join(PROMPT_DIR, 'memory-recap.txt');
      fs.writeFileSync(recapPromptPath,
        `You distill a chat transcript into an episodic memory recap for the agent's vault. Output ONLY raw markdown with this exact shape (no preamble, no code fences):\n\n` +
        `# Recap — <ISO date> — ${agentName || 'agent'}\n` +
        `**Goal:** <one line>\n` +
        `**Key decisions:** <one line>\n` +
        `**Open threads:** <one line or "none">\n` +
        `**Follow-ups:** <one line or "none">\n` +
        `**Durable facts to upsert into semantic memory:** <comma-separated, or "none">\n`,
        'utf8');
      const message = `Transcript:\n${transcript.map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`).join('\n\n')}`;
      const result = await callClaude({ message, sessionId: null, systemPromptPath: recapPromptPath, timeoutMs: 90000 });
      return sendJSON(res, 200, { ok: true, recap: (result.result || '').trim() });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ── GET /memory/:slug/:version → list vault files (paths + sizes only) ──
  if (req.method === 'GET' && url.pathname.startsWith('/memory/')) {
    try {
      const parts = url.pathname.replace(/^\/memory\//, '').split('/').filter(Boolean).map(safePart);
      if (parts.length !== 2) return sendJSON(res, 400, { ok: false, error: 'expected /memory/<slug>/<version>' });
      const memDir = path.join(LIBRARY_DIR, parts[0], parts[1], 'memory');
      if (!memDir.startsWith(LIBRARY_DIR + path.sep) || !fs.existsSync(memDir)) return sendJSON(res, 404, { ok: false, error: 'no vault for this version' });
      const files = [];
      const walk = dir => {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) walk(full);
          else files.push({ path: path.relative(memDir, full).replace(/\\/g, '/'), size: stat.size });
        }
      };
      walk(memDir);
      return sendJSON(res, 200, { ok: true, files });
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
    }
  }

  // ── GET /assets/* → static file from project root (images only) ──
  if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const requested = decodeURIComponent(url.pathname.replace(/^\/assets\//, ''));
    // safety: no path traversal, must resolve inside ROOT
    const safe = path.normalize(requested).replace(/^(\.\.[\\/])+/, '');
    const full = path.join(ROOT, safe);
    if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const ext = path.extname(full).toLowerCase();
    const mime = { '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.svg':'image/svg+xml', '.webp':'image/webp', '.ico':'image/x-icon', '.gif':'image/gif' }[ext];
    if (!mime) { res.writeHead(415); res.end('unsupported'); return; }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

ensureLibrary().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────────┐');
    console.log('  │  AgentEye Hub — Claude Code bridge                       │');
    console.log('  │                                                          │');
    console.log(`  │  → http://localhost:${PORT}${' '.repeat(38 - String(PORT).length)}│`);
    console.log('  │  → Spawns local `claude -p` for every turn               │');
    console.log('  │  → Uses your already-logged-in Claude Code session       │');
    console.log(`  │  → Library: ${GIT_AVAILABLE ? 'Git-backed ' : 'filesystem-only '}at ./library${' '.repeat(GIT_AVAILABLE ? 22 : 18)}│`);
    console.log('  └──────────────────────────────────────────────────────────┘');
    console.log('');
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Try:  PORT=7861 node server.js\n`);
    process.exit(1);
  }
  throw err;
});
