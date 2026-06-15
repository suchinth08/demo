# IDOA — Interas Data Operations Accelerator (on AgentEye)

> A reusable, AI-native foundation for building **data-intensive operational applications** —
> data intake, quality/validation, exception management, workflows, AI-assisted operations,
> and operational insights — generated as **owned, readable code**, not run as a black box.
> IDOA is delivered as a **new archetype** on the AgentEye platform.

---

## 1. Positioning & the one invariant

IDOA is the AgentEye thesis (spec → governed code, weeks-not-months, Library reuse) pointed at a
new application shape. The platform already proves this pattern live for **agents** and
**dashboard-portals**; IDOA adds **data products** as a third archetype.

**Invariant (never cross this line):** AgentEye **generates + catalogs + binds**; it does **not
operate** the customer's data. Every "Operations" capability below is generated *into the
customer's app* and runs in *their* estate. The day AgentEye executes customers' pipelines or
hosts their data, it has become a platform to operate — out of scope (a separate SaaS bet).

## 2. IDOA → AgentEye coverage map

| IDOA capability | Mechanism in AgentEye |
|---|---|
| Data intake (file / API / DB / stream / scheduled) | **source primitives** (typed adapters) |
| Data quality & validation | **check catalogue** + the **data contract** |
| Exception management / human review | **exception-queue + review-UI primitive** (runtime HITL) |
| Workflow orchestration | `workflows[]` state machines + the pipeline DAG |
| Enterprise integrations | connector refs (Secrets Manager ARNs) + adapters |
| AI-assisted operations | **smart-node primitive** (SLM) + Library agents |
| Operational insights / dashboards | **Operations group** → operational console (composes with dashboard-portal) |
| Day-2 operations (schedule, retries, backfill, alerting, audit/lineage) | **Operations group** (generated runtime) |
| Reusable foundation / weeks-not-months | the AgentEye generation pipeline itself |
| Self-service | architect *builds*; business users *operate* in the generated app |

Target coverage: **~90%** of the IDOA brief. Deliberately deferred: citizen (non-technical)
authoring; managed/hosted runtime.

## 3. Two model surfaces · two HITL loops (do not conflate)

**Model surfaces**
- **Builder-time LLM** (Claude / OpenRouter) — quality-critical, low volume, interactive. *This is AgentEye.*
- **Runtime model surface** — what the *generated* data product calls during batch: an **SLM**
  (Qwen on **Ollama** for on-prem / data residency) behind a pluggable provider, swappable to
  vLLM / Bedrock for throughput. **Don't marry Ollama.**

**HITL loops**
| Loop | When | Who | Surface |
|---|---|---|---|
| Design-time | build | consultant/architect | **AgentEye chat + form + journey** (drives the spec) |
| Run-time | operate | business operator | **generated app's exception queue / approvals** (+ embedded ops assistant) |

The AgentEye chat **designs** the operations console; it is **not** that console (nobody reviews
10M rows in a chat).

## 4. The meta-model — a composition framework, not a fixed template

A data product is **not** one template; it is a **declarative pipeline DAG** composed from a small
set of stable primitives. **All variability lives in the spec, not the generator.**

**Primitives (~stable):**
- **source** — file(CSV/Excel) · API · DB · stream · scheduled
- **entity / schema** — typed data model; instances are customer data
- **check** — required · type · range · regex · referential · uniqueness · custom *(deterministic, HARD)*
- **transform** — map · derive · enrich
- **smartNode** — *soft* AI task (classify/extract/explain) via the runtime model provider;
  output **validated by deterministic checks**; low confidence → exception queue. **Never on a hard gate.**
- **exception** — queue + review/correct/reprocess policy *(runtime HITL)*
- **sink** — Postgres table · API · export · event · **dashboard-portal** (reuses the app archetype)
- **operations** — scheduler/run-state · retries/idempotency · backfill/reprocess · operational
  console · alerting · audit & lineage

**Blueprint presets** (the marketable "archetypes" = pre-wired compositions, then customized):
*File-to-warehouse with DQ gate* · *API sync + reconciliation* · *Reference-data/MDM with
stewardship* · *Operational exception workspace*.

**The data contract** is the spine (analogous to `solution.manifest.json`): intake validates
against it, the DQ engine enforces it, migrations derive from it, sinks/dashboards read it,
consumers pin it.

## 5. Handling ad-hoc / per-customer variability — compose → contract → contribute

| Tier | Need | Handling | Result |
|---|---|---|---|
| **Compose** | standard source/checks | parameterize primitives in the spec | 100% generated |
| **Contract** | custom validation/transform | spec declares it → generator emits **typed contract + stub** → filled in-repo (bounded LLM fill + human sign-off) | scaffolded, governed |
| **Contribute** | novel source/sink | implement the primitive interface → **publish to Library** | grows the flywheel |

No customer ever forks the generator — the platform invariant.

## 6. The mesh (deferred to P3) — producer/consumer over the Library

Agents, apps, and data products are all **Library assets**, bound by **versioned data contracts**
(`contract@vNNN`, same pin model apps use for agents). A portal *consumes* a data product; an
agent *operates over* one; a data product *calls* agents/SLMs. A **Hub view** = registry of
contracts + lineage + owners (NOT a data catalog, NOT the data, NOT a query engine).

## 7. Artifacts (mapped to the existing tier0/1/2 manifest)

- **Tier 0 — design:** pipeline DAG spec · logical data model · **data contract per entity** ·
  DQ rule catalogue · lineage/flow diagram · data dictionary · governance classification (PII/residency/retention).
- **Tier 1 — code:** ingestion adapters · validation engine + checks · exception-queue service +
  review UI · transforms · **entity migrations (DDL from contract)** · sink writers · smart-node +
  model-provider wiring · operational console · scheduler/orchestrator · typed contracts + `todo` tests for custom stages.
- **Tier 2 — deploy:** stack IaC (landing bucket · queue · job runner · Postgres/warehouse · app ·
  model-serving) · CI/CD · per-env params · runbook · **data-governance pack** (lineage/retention/residency) · cost model.

## 8. Spec-linter (runs before codegen — keeps ad-hoc specs from generating broken repos)

DAG is acyclic & well-formed · every check references a real field · sinks are schema-compatible ·
no orphan stages · **no model bound to a hard gate** (smartNode ≠ check) · inferred schemas require
human confirmation · contract versions resolve.

## 9. Phasing

- **P1 — MVP (prove the thesis):** file intake → validate → exception queue/review → Postgres sink
  → DQ dashboard → one smart node. Conversationally driven; generates a runnable repo.
- **P2 — Operations (makes it *IDOA*):** scheduler/run-state · operational console · alerting ·
  backfill/reprocess · audit/lineage.
- **P3 — Mesh:** publish to Library · `contract@vNNN` binding · Hub view · cross-archetype composition.
- **P4 — Breadth:** more sources/SLM providers · MDM/CDC patterns · citizen-authoring exploration.

## 10. Build plan into AgentEye (this engagement)

New "data-product" archetype wired into the existing track/orchestrator/journey machinery:
1. **Home** — add a *Data Platform Accelerator* section (content-only; no theme redesign).
2. **Landing + orchestrator** — selecting the archetype shows an explainer landing (what it is +
   capabilities) → CTA → routes into the data-product build conversation.
3. **`dataproduct.txt`** — staged elicitation prompt (DATA_MODEL → INTAKE → VALIDATION →
   EXCEPTIONS → OPERATIONS → AGENT_INTEGRATION → IDENTITY → ENTERPRISE → COMPLETE), with
   schema-inference-from-sample and the consistency validator.
4. **SolutionSpec extension** — `archetype:"data-product"` + `dataProduct{ sources[], entities[],
   checks[], transforms[], smartNodes[], exceptions, sinks[], operations }` + contract.
5. **Generator** — `appgen` data-product blueprint emitting the P1 primitives + contracts + verify gate.
6. **Spec-linter** — the §8 rules.
7. **Verify → commit+push → deploy** (Railway + Vercel; Supabase already wired).

### Fit-for-purpose model assignments (cost discipline)
- **Opus** (architecture/governance/review): this doc, `dataproduct.txt`, SolutionSpec schema,
  generator design, spec-linter, deploy.
- **Sonnet** (routine UI / deterministic templates): Home section, landing page, generator file templates.
- **Haiku**: trivial content/string tasks only.
Opus always reviews + runs the verify gate on delegated work.
