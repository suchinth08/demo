#!/usr/bin/env node
// cfn/lint.js — validate every generated agent.cfn.yaml.
//
// Primary gate: cfn-lint (tries `cfn-lint` on PATH, then `python -m cfnlint`).
// Fallback: if cfn-lint isn't installed/working, runs the offline structural
// gate (js-yaml re-parse + invariant checks) so the script is always useful.
// Exits non-zero on any failure.

'use strict';

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { validateTemplate } = require('./build');

const LIBRARY_DIR = path.join(__dirname, '..', 'library');
const isWin = process.platform === 'win32';

function findTemplates() {
  const out = [];
  if (!fs.existsSync(LIBRARY_DIR)) return out;
  for (const slug of fs.readdirSync(LIBRARY_DIR)) {
    const slugDir = path.join(LIBRARY_DIR, slug);
    if (slug.startsWith('.') || !fs.statSync(slugDir).isDirectory()) continue;
    for (const v of fs.readdirSync(slugDir)) {
      const f = path.join(slugDir, v, 'agent.cfn.yaml');
      if (fs.existsSync(f)) out.push({ slug, version: v, file: f });
    }
  }
  return out;
}

// Returns the runnable cfn-lint command, or null if unavailable.
function detectCfnLint() {
  for (const cmd of [['cfn-lint', ['--version']], ['python', ['-m', 'cfnlint', '--version']]]) {
    const r = spawnSync(cmd[0], cmd[1], { shell: isWin, encoding: 'utf8' });
    if (r.status === 0) return cmd[0] === 'cfn-lint' ? ['cfn-lint', []] : ['python', ['-m', 'cfnlint']];
  }
  return null;
}

function main() {
  const templates = findTemplates();
  if (!templates.length) { console.log('No agent.cfn.yaml files found. Run `npm run cfn:backfill` first.'); process.exit(0); }

  const lint = detectCfnLint();
  let failed = 0;

  if (lint) {
    console.log(`Gate: cfn-lint (${lint[0]} ${lint[1].join(' ')})\n`);
    for (const t of templates) {
      const r = spawnSync(lint[0], [...lint[1], t.file], { shell: isWin, encoding: 'utf8' });
      if (r.status === 0) console.log(`  ✓ ${t.slug}/${t.version}`);
      else { failed++; console.error(`  ✗ ${t.slug}/${t.version}\n${(r.stdout || '') + (r.stderr || '')}`); }
    }
  } else {
    console.log('Gate: OFFLINE structural check (cfn-lint not available — install it for full AWS-spec validation: `pip install cfn-lint`)\n');
    for (const t of templates) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(t.file), 'meta.json'), 'utf8'));
        validateTemplate(fs.readFileSync(t.file, 'utf8'), meta.agent || meta);
        console.log(`  ✓ ${t.slug}/${t.version}`);
      } catch (e) { failed++; console.error(`  ✗ ${t.slug}/${t.version}: ${e.message}`); }
    }
  }

  console.log(`\n${templates.length - failed}/${templates.length} passed.`);
  process.exit(failed ? 1 : 0);
}

main();
