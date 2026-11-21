#!/usr/bin/env node
// tools/validate-scenario.mjs
// Node-only scenario check — no k6, no TFE. Validates against the documented format
// (same lib/validate-core.js that k6 runs at startup), then prints the stage plan,
// approximate active time, and the env vars you must set. Exits non-zero and lists
// ALL problems if the file is invalid.
//
// Usage: node tools/validate-scenario.mjs <scenario.json> [--print-plan]

import { readFileSync } from 'node:fs';
import { validateScenario } from '../lib/validate-core.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/validate-scenario.mjs <scenario.json> [--print-plan]');
  process.exit(2);
}

let d;
try { d = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
  console.error(`cannot parse JSON: ${e.message}`);
  process.exit(2);
}

const { errors, warnings } = validateScenario(d);
for (const w of warnings) console.log(`warn: ${w}`);
if (errors.length) {
  console.error(`\nINVALID (${errors.length} problem${errors.length === 1 ? '' : 's'}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const name = (d.test && d.test.name) || '(scenario)';
console.log(`\nvalid: ${name}  (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`);

const toSec = (x) => {
  const m = /^([0-9]+)(s|m|h)?$/.exec(String(x || ''));
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
};

const s = d.stages || {};
const list = Array.isArray(s.concurrency) ? s.concurrency : [];
const dwell = s.dwell || '15m';
const gstop = s.graceful_stop || '5m';
const runs = list.length + (s.return_to_baseline ? 1 : 0);

console.log('\nstages (one k6 run each):');
list.forEach((c, i) => {
  const tag = (i === 0 && s.warmup_stage !== false) ? '[warmup] ' : '         ';
  const regime = regimeFor(c, d);
  console.log(`  ${tag}c=${String(c).padStart(3)}  dwell=${dwell}  gracefulStop=${gstop}${regime}`);
});
if (s.return_to_baseline) console.log(`  [return] c=${String(s.return_to_baseline).padStart(3)}  (drift check)`);

const activeMin = Math.round((runs * toSec(dwell)) / 60);
console.log(`\napprox active time: ~${activeMin} min across ${runs} stage run(s) (plus ramp + graceful-stop spillover)`);

const envs = new Set([(d.tfe && d.tfe.token_env) || 'TFE_TOKEN']);
if (d.tfe && d.tfe.admin_token_env) envs.add(d.tfe.admin_token_env);
if (d.artifactory && d.artifactory.token_env) envs.add(d.artifactory.token_env);
console.log(`\nrequired env vars: ${[...envs].join(', ')}`);
console.log('(prefer SSL_CERT_FILE=<private-ca.pem> over tls_skip_verify)');

function regimeFor(c, scenario) {
  const oc = scenario.observed_config || {};
  const ceiling = (Number(oc.tfe_capacity_concurrency) || 0) * (Number(oc.terraform_enterprise_replicas) || 0);
  if (!ceiling) return '';
  return c >= ceiling ? `  (>= ceiling ${ceiling})` : '';
}
