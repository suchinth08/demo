#!/usr/bin/env node
// cfn/build.js — generate agent.cfn.yaml for one or all Library versions.
//
//   node cfn/build.js <slug> <version>   → build one
//   node cfn/build.js --all              → backfill every version bundle
//   node cfn/build.js --check <slug> <version>  → build to stdout, don't write
//
// After writing, each template is offline-validated: re-parsed with js-yaml and
// checked for the structural invariants every Phase-1 agent template must hold.

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { buildAgentCfn } = require('./agent-cfn');

const LIBRARY_DIR = path.join(__dirname, '..', 'library');

// Re-parse + assert invariants. Throws on any violation. Returns the parsed template.
function validateTemplate(text, agent) {
  const t = yaml.load(text); // throws on malformed YAML
  if (!t || typeof t !== 'object') throw new Error('template is not an object');
  if (t.AWSTemplateFormatVersion !== '2010-09-09') throw new Error('missing AWSTemplateFormatVersion');
  const R = t.Resources || {};
  for (const need of ['AgentExecutionRole', 'Agent', 'AgentAlias']) {
    if (!R[need]) throw new Error(`missing required resource ${need}`);
  }
  if (R.Agent.Type !== 'AWS::Bedrock::Agent') throw new Error('Agent has wrong Type');
  if (!t.Parameters || !t.Parameters.FoundationModelId) throw new Error('missing FoundationModelId parameter');
  for (const o of ['AgentId', 'AgentArn', 'AgentAliasId', 'AgentAliasArn']) {
    if (!t.Outputs || !t.Outputs[o] || !t.Outputs[o].Export) throw new Error(`missing exported output ${o}`);
  }
  // guardrail / supervisor coherence
  if (agent.guardrails && !R.Guardrail) throw new Error('agent has guardrails but no Guardrail resource');
  if (agent.agentMode === 'supervisor') {
    if (R.Agent.Properties.AgentCollaboration !== 'SUPERVISOR') throw new Error('supervisor missing AgentCollaboration');
    (agent.collaborators || []).forEach(c => {
      const pid = 'Collaborator' + c.agentName.replace(/[^a-zA-Z0-9]+/g, ' ').split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('') + 'AliasArn';
      if (!t.Parameters[pid]) throw new Error(`missing collaborator parameter ${pid}`);
    });
  }
  return t;
}

function readAgent(verDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(verDir, 'meta.json'), 'utf8'));
  return meta.agent || meta;
}

function buildOne(slug, version, { write = true } = {}) {
  const verDir = path.join(LIBRARY_DIR, slug, version);
  const agent = readAgent(verDir);
  const yamlText = buildAgentCfn(agent);
  validateTemplate(yamlText, agent);
  if (write) fs.writeFileSync(path.join(verDir, 'agent.cfn.yaml'), yamlText);
  return yamlText;
}

function eachVersion(fn) {
  for (const slug of fs.readdirSync(LIBRARY_DIR)) {
    const slugDir = path.join(LIBRARY_DIR, slug);
    if (slug.startsWith('.') || slug === 'README.md' || !fs.statSync(slugDir).isDirectory()) continue;
    for (const version of fs.readdirSync(slugDir)) {
      if (!/^v\d+$/.test(version)) continue;
      fn(slug, version);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--all') {
    let ok = 0, fail = 0;
    eachVersion((slug, version) => {
      try { buildOne(slug, version); console.log(`  ✓ ${slug}/${version}`); ok++; }
      catch (e) { console.error(`  ✗ ${slug}/${version}: ${e.message}`); fail++; }
    });
    console.log(`\n${ok} built, ${fail} failed.`);
    process.exit(fail ? 1 : 0);
  }
  if (args[0] === '--check') {
    process.stdout.write(buildOne(args[1], args[2], { write: false }));
    return;
  }
  if (args.length === 2) {
    buildOne(args[0], args[1]);
    console.log(`✓ wrote library/${args[0]}/${args[1]}/agent.cfn.yaml`);
    return;
  }
  console.error('usage: node cfn/build.js <slug> <version> | --all | --check <slug> <version>');
  process.exit(2);
}

if (require.main === module) main();
module.exports = { buildOne, validateTemplate };
