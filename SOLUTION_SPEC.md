# SolutionSpec & AppSpec — schema reference (v0.1, draft)

The data contract for AgentEye's **App / Solution track**. Mirrors the role that
`agentConfig` plays for the Agent track, but a **Solution** is a higher-level
container: *one app + the agents it pins = one deployable, versionable, forkable
bundle.*

This file is the human + server reference. The conversational elicitation prompt
(`.agenteye_prompts/app.txt`) embeds a trimmed copy so the model emits it each turn.

---

## 0. Top-level shape

```jsonc
{
  "kind": "solution",                       // "solution" | "app" | "agent"
  "schemaVersion": "0.1",

  "name": null,                             // "PatientPortal"
  "slug": null,                             // derived; namespaced by kind in the graph: app:patientportal
  "version": null,                          // assigned at publish (v001…); see versioning notes
  "archetype": "dashboard-portal",          // LOCKED for v1; gallery shows others as "coming soon"
  "description": null,
  "targetUsers": null,

  // ── Tenancy (LOCKED decision: Catalog vs Client Workspace) ───────────────
  "tenancy": {
    "scope": "client-workspace",            // "client-workspace" (isolated instance) | "catalog" (sanitized reusable IP)
    "clientId": null,                       // required when scope=client-workspace
    "promotedFrom": null,                   // if scope=catalog and promoted from a client solution (after PII scrub)
    "sanitized": false                      // catalog entries must be true before publish
  },

  // ── Environment axis (LOCKED: version × environment) ─────────────────────
  "environments": ["dev", "stage", "prod"], // each resolves its own deploy params at build time

  "app":    { /* AppSpec — section 1 */ },
  "agents": [ /* pinned agent refs — section 2 */ ],

  // ── Cross-cutting: validation + generation provenance ────────────────────
  "validation": [ /* consistency-validator findings — section 3 */ ],
  "generation": { /* reproducibility stamp + gate — section 4 */ },

  "artifacts": { /* Tier 0/1/2 manifest, filled at COMPLETE — section 5 */ },

  "stage": "SOLUTION",                      // current elicitation stage
  "readyToGenerate": false                  // true only at COMPLETE with a full plan
}
```

---

## 1. AppSpec (`solution.app`)

```jsonc
{
  "stack": {
    "frontend":     "react-vite",           // blessed golden path
    "componentLib": "shadcn-tailwind",       // tokenized theming foundation (see theme); MUI is the alt
    "language":     "typescript",
    "bff":          "node-fastify",          // BFF that brokers frontend ↔ agent ↔ data; node-express alt
    "database":     "aurora-serverless-pg"   // | "postgres-rds" | "dynamodb"
  },

  // ── Theme: GENERATED app is client-brandable; Accenture is just the default preset ──
  "theme": {
    "palette":    "accenture",               // "accenture" | "neutral" | "material" | "custom"
    "tokens": {                              // semantic tokens, NOT hardcoded component colors
      "primary":  "#A000FF",
      "accent":   "#C1A3FF",
      "surface":  "#FFFFFF",
      "ink":      "#000000",
      "muted":    "#6B6B6B"
    },
    "mode":       "light",                   // "light" | "dark" | "auto"
    "logoRef":    null,                      // asset ref or Secrets/asset store path
    "fontFamily": null,
    "a11y":       "WCAG-AA"                   // generator enforces contrast on whatever palette
  },

  // ── App-tier identity; user identity MUST propagate into the agent call ──
  "identity": {
    "provider":         "cognito",           // "cognito" | "entra" | "okta" | "saml" | "none"
    "rbacRoles":        [],                   // e.g. ["clinician","front-desk","admin"]
    "sessionStrategy":  "jwt",
    "propagateToAgent": true                  // injects caller identity into InvokeAgent (audit/PII/guardrails)
  },

  // ── Layout: pages reference widgets by id ──
  "pages": [
    {
      "id": "overview",
      "title": "Overview",
      "route": "/",
      "layout": "grid",                       // "grid" | "split" | "single"
      "roles": [],                            // empty = all authenticated roles
      "widgets": ["kpi-cards", "trend-chart", "recent-table", "assistant"]
    }
  ],

  "widgets": [
    { "id": "kpi-cards",   "type": "kpi",        "title": "Key metrics", "dataSourceId": "ops-db",  "refresh": "60s" },
    { "id": "trend-chart", "type": "chart",      "title": "Trend",       "dataSourceId": "ops-db",  "chart": "line" },
    { "id": "recent-table","type": "table",      "title": "Recent",      "dataSourceId": "ops-db",  "pageSize": 25 },
    { "id": "assistant",   "type": "agent-chat", "title": "Assistant",   "agentRef": "patientcarecoordinator:v001", "binding": "bff", "streaming": true }
  ],

  "data": {
    "sources": [
      { "id": "ops-db", "type": "database", "engine": "postgres", "secretRef": "arn:aws:secretsmanager:...", "iamAuth": true }
    ],
    "governance": {
      "residency":         "match-agent-region",  // app data region MUST match the pinned agent's region
      "piiClassification": "review",               // "none" | "review" | "restricted"
      "migrations":        "managed",              // generated migration scaffold
      "backup":            "default",
      "retentionDays":     null
    }
  },

  "guardrails": null,                          // reuse agent guardrails shape for the app's chat surface

  // ── ENTERPRISE: reused verbatim from the agent track + app-hosting & CI/CD ──
  "enterprise": {
    "network":      { "mode": "vpcEndpoints", "vpcId": null, "subnetIds": [], "securityGroupIds": [] },
    "encryption":   { "mode": "aws-managed", "kmsKeyArn": null },
    "approvals":    { "mode": "writes-only", "approverGroupArn": null },
    "observability":{ "cloudwatchLogs": true, "xrayTracing": true, "correlationIds": true, "frontendRUM": false, "externalCollectorUrl": null },
    "tags":         { "Project": null, "Environment": null, "Owner": null, "CostCenter": null },  // SAME set rolls up across app + agent stacks
    "dr":           { "posture": "single-region", "primaryRegion": null, "secondaryRegion": null },
    "quotas":       { "perAgentRpm": null },

    "hosting": {
      "frontend": "cloudfront-s3",             // | "amplify"
      "bff":      "lambda-apigw",              // | "apprunner" | "fargate"
      "iac":      "cloudformation"             // homogeneous with the agent stack
    },
    "cicd": {
      "platform":    "github-actions",         // bless ONE in v1; others stubbed
      "environments":["dev","stage","prod"],
      "signOffGate": true,                     // build-time human approval before prod deploy
      "scans":       ["sbom","sca","sast","license"],
      "approvedTech": null,                    // optional client approved-tech allowlist constraint
      "rollback":    true
    }
  }
}
```

---

## 2. Pinned agents (`solution.agents[]`)

Same `slug:vNNN` pin model as agent→agent collaborators. **Fork-by-reference:**
forking a Solution does NOT copy its agents.

```jsonc
{
  "slug":    "patientcarecoordinator",
  "version": "v001",                          // PINNED. /graph flags stale when a newer version exists
  "role":    "primary",                       // "primary" | "support"
  "binding": "bff",                            // how the app talks to it
  "interfaceContract": {                       // copied from the agent's meta at pin time; enables CHECKED compat
    "input":   { "type": "text" },
    "output":  { "type": "text+trace" },
    "session": "per-user",
    "auth":    "identity-propagated"
  }
}
```

---

## 3. Consistency validator (`solution.validation[]`)

First-class design-time cross-checker. Each finding:

```jsonc
{ "level": "error" | "warn", "code": "REGION_MISMATCH", "message": "App data region us-west-2 ≠ agent region us-east-1", "fixHint": "Set data.governance.residency or move the agent" }
```

Checks (minimum set):
- **REGION_MISMATCH** — app data/hosting region vs each pinned agent's region.
- **NETWORK_UNREACHABLE** — BFF can't reach a PrivateLink-only agent (must share VPC/subnets).
- **CAPABILITY_MISSING** — a widget's `agentRef` references behavior the agent's interfaceContract doesn't expose.
- **STALE_PIN** — newer agent version exists (mirrors existing `/graph` flag; warn, not error).
- **IDENTITY_GAP** — `propagateToAgent: true` but `identity.provider: "none"`.
- **TAG_DRIFT** — app `CostCenter`/`Project` tags differ from the pinned agent's (breaks cost rollup).
- **UNSANITIZED_CATALOG** — `tenancy.scope: "catalog"` but `sanitized: false`.

`readyToGenerate` must be `false` while any `level: "error"` finding is open.

---

## 4. Generation provenance & gate (`solution.generation`)

```jsonc
{
  "blueprintVersion": "dashboard-portal@0.1",
  "modelVersion":     null,                    // stamped at generation
  "skeleton":         "deterministic",         // fixed skeleton + bounded fill slots (reproducibility)
  "regeneration":     "one-time",              // LOCKED: generate once; re-pin patches binding only, never app code
  "verificationGate": ["install","build","typecheck","lint","test"],  // all must pass (self-repair) before publish
  "generatedAt":      null,
  "promptDigest":     null                     // hash of the resolved generation prompt
}
```

---

## 5. Artifact manifest (`solution.artifacts`) — filled at COMPLETE

Three tiers (the deliverable, vs AgentEye's single CFN template):

```jsonc
{
  "tier0_design": ["solution.json", "wireframe.html", "README.md", "ARCHITECTURE.md", "ADRs/", "threat-model.md"],
  "tier1_code":   ["app/ (react-vite)", "bff/ (node)", "runs via: npm install && npm run dev"],
  "tier2_deploy": ["iac/app.cfn.yaml", "iac/agent.cfn.yaml (per pinned agent)", "deploy/ (parent manifest, params←outputs)", ".cicd/ (github-actions)"]
}
```

**Fusion (deploy-time):** app CFN takes the agent stack's runtime coords
(`AGENT_ID`, `AGENT_ALIAS_ID`, `REGION`) as **parameters** (agent `Outputs` as
defaults) — NOT hard `Fn::ImportValue` — plus a `bedrock:InvokeAgent` IAM grant
and shared network posture. `deploy/` deploys agent stack first, feeds outputs → app params.

---

## Versioning & forking (reuses existing Library machinery)

- Storage: `library/<slug>/vNNN/` + `meta.json` gains `kind`. Same publish → increment → git-commit.
- Graph: nodes are agents **and** solutions; node ids namespaced by kind (`app:…` / `agent:…`).
- Two operations: **fork the solution** (new version/slug, copies spec) vs **re-pin a dependency** (bump `vNNN`, patch binding only).
- Two git layers: **Library** = append-only registry/provenance; **generated repo** = the consultant's living code.

> v1 is AWS-native. The SolutionSpec itself is kept cloud-agnostic — cloud
> specifics live only in `enterprise.hosting` / `iac` — so an Azure/GCP target
> stays possible later without reshaping the spec.
