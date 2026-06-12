#!/usr/bin/env node
// cfn/deploy-manifest.js — build a portable deploy/ bundle for a SUPERVISOR
// agent and the collaborator agents it pins. Proves end-to-end fusion:
// deploy each collaborator stack first, read its AgentAliasArn output, thread it
// into the supervisor's CollaboratorXAliasArn PARAMETER (no hard ImportValue).
//
//   node cfn/deploy-manifest.js <slug> <version>
//
// Writes into library/<slug>/<version>/deploy/:
//   manifest.json        — declarative source of truth (stacks, order, wiring)
//   templates/*.yaml      — self-contained copies of every stack in the closure
//   deploy.sh             — portable runner (aws cli; Linux/mac/git-bash)
//   README.md             — prerequisites, run, teardown

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { logicalId } = require('./agent-cfn');

const LIBRARY_DIR = path.join(__dirname, '..', 'library');

function loadAgent(slug, version) {
  const verDir = path.join(LIBRARY_DIR, slug, version);
  const metaPath = path.join(verDir, 'meta.json');
  if (!fs.existsSync(metaPath)) throw new Error(`no meta.json at library/${slug}/${version}`);
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  return { agent: meta.agent || meta, verDir };
}

function parsePin(agentId) {
  // "prescriptionspecialist:v001" → { slug, version }
  const m = String(agentId || '').match(/^([a-z0-9-]+):(v\d+)$/i);
  if (!m) return null;
  return { slug: m[1], version: m[2] };
}

// Resolve the full dependency closure as a DAG (cycle-safe). Returns nodes map
// keyed by "slug:version" and a leaves-first topological order.
function resolveClosure(rootSlug, rootVersion) {
  const nodes = {};            // key → { slug, version, agent, collaborators: [{key, name, paramName}] }
  const slugSeen = {};         // slug → version, to catch two versions of one slug in a closure
  const stack = [];            // for cycle detection
  const order = [];            // post-order = leaves first
  const done = new Set();

  function visit(slug, version) {
    const key = `${slug}:${version}`;
    if (done.has(key)) return key;
    if (stack.includes(key)) throw new Error(`dependency cycle detected at ${key} (path: ${stack.join(' → ')})`);
    if (slugSeen[slug] && slugSeen[slug] !== version) {
      throw new Error(`closure pins two versions of "${slug}" (${slugSeen[slug]} and ${version}); not supported`);
    }
    slugSeen[slug] = version;
    stack.push(key);

    const { agent } = loadAgent(slug, version);
    const collaborators = [];
    if (agent.agentMode === 'supervisor') {
      for (const c of (agent.collaborators || [])) {
        const pin = parsePin(c.agentId);
        if (!pin) { console.warn(`  [warn] ${key}: collaborator "${c.agentName}" has unparseable pin "${c.agentId}", skipping`); continue; }
        const childKey = visit(pin.slug, pin.version);
        collaborators.push({ key: childKey, name: c.agentName, paramName: `Collaborator${logicalId(c.agentName)}AliasArn` });
      }
    }
    nodes[key] = { key, slug, version, agent, collaborators };
    stack.pop();
    done.add(key);
    order.push(key);           // children already pushed → leaves first
    return key;
  }

  visit(rootSlug, rootVersion);
  return { nodes, order };
}

function buildDeployBundle(rootSlug, rootVersion) {
  const { nodes, order } = resolveClosure(rootSlug, rootVersion);
  const rootKey = `${rootSlug}:${rootVersion}`;
  if (!nodes[rootKey].collaborators.length) {
    throw new Error(`${rootKey} has no collaborators — a deploy bundle is only meaningful for a supervisor with pinned agents.`);
  }

  const deployDir   = path.join(LIBRARY_DIR, rootSlug, rootVersion, 'deploy');
  const templateDir = path.join(deployDir, 'templates');
  fs.rmSync(deployDir, { recursive: true, force: true });
  fs.mkdirSync(templateDir, { recursive: true });

  // Copy each stack's template into the bundle (self-contained) + build manifest.
  const stacks = order.map(key => {
    const n = nodes[key];
    const src = path.join(LIBRARY_DIR, n.slug, n.version, 'agent.cfn.yaml');
    if (!fs.existsSync(src)) throw new Error(`missing ${n.slug}/${n.version}/agent.cfn.yaml — run \`npm run cfn:backfill\` first`);
    const templateFile = `${n.slug}__${n.version}.yaml`;
    fs.copyFileSync(src, path.join(templateDir, templateFile));
    return {
      name: n.slug,
      slug: n.slug,
      version: n.version,
      role: key === rootKey ? 'supervisor' : 'collaborator',
      template: `templates/${templateFile}`,
      dependsOn: n.collaborators.map(c => nodes[c.key].slug),
      params: n.collaborators.map(c => ({
        name: c.paramName,
        fromStackOutput: { stack: nodes[c.key].slug, output: 'AgentAliasArn' },
      })),
    };
  });

  const manifest = {
    solution: rootSlug,
    rootVersion,
    generator: 'deploy-manifest@0.1',
    capabilities: ['CAPABILITY_IAM'],
    finalOutput: 'AgentAliasArn',
    deployOrder: stacks.map(s => s.name),
    stacks,
  };
  fs.writeFileSync(path.join(deployDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(deployDir, 'deploy.sh'), renderDeployScript(manifest));
  fs.writeFileSync(path.join(deployDir, 'README.md'), renderReadme(manifest));

  verifyBundle(deployDir);   // self-verify; throws on any wiring inconsistency
  return { deployDir, manifest };
}

// Confirm every wired parameter exists in its target template AND the dependency
// stack actually exports the output the manifest reads. Throws on mismatch.
function verifyBundle(deployDir) {
  const m = JSON.parse(fs.readFileSync(path.join(deployDir, 'manifest.json'), 'utf8'));
  const tpl = rel => yaml.load(fs.readFileSync(path.join(deployDir, rel), 'utf8'));
  for (const s of m.stacks) {
    const params = Object.keys(tpl(s.template).Parameters || {});
    for (const w of s.params) {
      if (!params.includes(w.name)) throw new Error(`${s.name}: wired param "${w.name}" not found in template`);
      if (!w.fromStackOutput) continue;   // fromEnv params: only need to exist in the template
      const dep = m.stacks.find(x => x.name === w.fromStackOutput.stack);
      if (!dep) throw new Error(`${s.name}: dependency stack "${w.fromStackOutput.stack}" not in manifest`);
      const outputs = Object.keys(tpl(dep.template).Outputs || {});
      if (!outputs.includes(w.fromStackOutput.output)) throw new Error(`${dep.name}: does not export "${w.fromStackOutput.output}"`);
    }
  }
}

function renderDeployScript(m) {
  const L = [];
  L.push('#!/usr/bin/env bash');
  L.push(`# Generated by AgentEye (${m.generator || 'deploy-manifest'}). Deterministic — do not hand-edit; regenerate via AgentEye.`);
  L.push('#');
  L.push('# Deploys the stacks leaves-first, threading each upstream stack\'s outputs');
  L.push('# into the dependent stack\'s parameters (params, not ImportValue).');
  L.push('set -euo pipefail');
  L.push('');
  L.push('PREFIX="${1:-' + m.solution + '}"   # stack-name prefix, e.g. PatientPortal-prod');
  L.push('REGION="${2:-${AWS_REGION:-us-east-1}}"');
  L.push('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
  L.push('CAPS="' + m.capabilities.join(' ') + '"');
  L.push('');
  L.push('out() { aws cloudformation describe-stacks --stack-name "$1" --region "$REGION" \\');
  L.push('  --query "Stacks[0].Outputs[?OutputKey==\'$2\'].OutputValue" --output text; }');
  L.push('');
  L.push('echo "Deploying solution \'' + m.solution + '\' to region $REGION (prefix: $PREFIX)"');
  L.push('');
  for (const s of m.stacks) {
    L.push(`# ── ${s.role}: ${s.name} (${s.slug}:${s.version}) ──`);
    const stackVar = s.name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_STACK';
    L.push(`${stackVar}="$PREFIX-${s.name}"`);
    const overrides = [];
    for (const p of s.params) {
      if (p.fromStackOutput) {
        const depVar = p.fromStackOutput.stack.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_STACK';
        L.push(`${p.name}_VAL="$(out "$${depVar}" "${p.fromStackOutput.output}")"`);
      } else if (p.fromEnv) {
        L.push(`${p.name}_VAL="\${${p.fromEnv}:?${p.fromEnv} must be set}"`);
      }
      overrides.push(`${p.name}="$${p.name}_VAL"`);
    }
    L.push(`echo "  → $${stackVar}"`);
    L.push(`aws cloudformation deploy \\`);
    L.push(`  --template-file "$SCRIPT_DIR/${s.template}" \\`);
    L.push(`  --stack-name "$${stackVar}" \\`);
    L.push(`  --region "$REGION" \\`);
    L.push(`  --capabilities $CAPS${overrides.length ? ' \\' : ''}`);
    if (overrides.length) L.push(`  --parameter-overrides ${overrides.join(' ')}`);
    L.push('');
  }
  const last = m.deployOrder[m.deployOrder.length - 1];
  const lastVar = last.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_STACK';
  const finalOut = m.finalOutput || 'AgentAliasArn';
  L.push(`echo "Done. ${last} ${finalOut}:"`);
  L.push(`out "$${lastVar}" "${finalOut}"`);
  L.push('');
  return L.join('\n');
}

function renderReadme(m) {
  return `# Deploy bundle — ${m.solution}

Self-contained CloudFormation deploy for the **${m.solution}** solution: the
supervisor agent plus every collaborator it pins. Generated deterministically by
AgentEye (\`${m.generator}\`).

## What's here
- \`manifest.json\` — declarative source of truth (stacks, deploy order, param↔output wiring).
- \`templates/\` — a self-contained copy of each stack's CloudFormation template.
- \`deploy.sh\` — portable runner.

## Deploy order (leaves first)
${m.deployOrder.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Each collaborator stack is deployed first; its \`AgentAliasArn\` output is read and
passed as a **parameter** into the supervisor stack (no hard \`ImportValue\`, so the
stacks keep independent lifecycles).

## Prerequisites
- AWS CLI v2, authenticated to the target account (\`aws sts get-caller-identity\`).
- Bedrock model access enabled in the region for the model in each template's
  \`FoundationModelId\` parameter default (override per stack if needed).

## Run
\`\`\`bash
./deploy.sh <stack-name-prefix> <region>
# e.g.
./deploy.sh ${m.solution}-prod us-east-1
\`\`\`

## Teardown (reverse order)
\`\`\`bash
${[...m.deployOrder].reverse().map(s => `aws cloudformation delete-stack --stack-name <prefix>-${s} --region <region>`).join('\n')}
\`\`\`
`;
}

function main() {
  const [slug, version] = process.argv.slice(2);
  if (!slug || !version) { console.error('usage: node cfn/deploy-manifest.js <slug> <version>'); process.exit(2); }
  const { deployDir, manifest } = buildDeployBundle(slug, version);
  console.log(`✓ wrote ${path.relative(path.join(__dirname, '..'), deployDir)}/`);
  console.log(`  deploy order: ${manifest.deployOrder.join(' → ')}`);
}

if (require.main === module) main();
module.exports = { buildDeployBundle, resolveClosure, verifyBundle, renderDeployScript };
