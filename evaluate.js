// evaluate.js
// Runs after each stage. Applies the SAME knee logic as merge.js over the stages
// completed so far and writes a decision the wrapper sources. "Confirmed" means
// the knee sits below the latest stage — i.e. we've already run at least one stage
// past it (v2's "run one stage past the expected knee to confirm it").
//
// Env: TEST_ID, TEST_DATA, DONE_LIST (concurrencies run so far), WARMUP_STAGE.
// Output: results/<TEST_ID>/decision.env

import { scoreStages, detectKnee } from './lib/knee.js';

const TEST_DATA = JSON.parse(open(__ENV.TEST_DATA || './config/scenario.example.json'));
const TEST_ID = __ENV.TEST_ID;
const DONE = String(__ENV.DONE_LIST || '').trim().split(/\s+/).filter(Boolean).map(Number);
const WARMUP = __ENV.WARMUP_STAGE === '1';

const stages = [];
for (const c of DONE) {
  let raw = null;
  try { raw = open(`results/${TEST_ID}/summary-stage-${c}.json`); } catch (_) { raw = null; }
  if (raw) { try { stages.push(JSON.parse(raw)); } catch (_) { /* skip */ } }
}

export const options = { vus: 1, iterations: 1 };
export default function () {}

export function handleSummary() {
  const oc = TEST_DATA.observed_config || {};
  const ceiling = (Number(oc.tfe_capacity_concurrency) || 0) * (Number(oc.terraform_enterprise_replicas) || 0);
  const scored = scoreStages(stages, { ceiling, warmup: WARMUP });
  const { knee, signal } = detectKnee(scored, TEST_DATA.saturation || {});
  const latest = DONE.length ? Math.max(...DONE) : null;

  const reached = knee != null ? 1 : 0;
  // Confirmed once we have a stage beyond the knee (plateau is inherently one-past;
  // failure/p95 signals become confirmed on the next stage).
  const confirmed = (knee != null && latest != null && knee < latest) ? 1 : 0;

  const lines = [
    `KNEE_REACHED=${reached}`,
    `KNEE_CONFIRMED=${confirmed}`,
    `KNEE_SIGNAL="${signal || ''}"`,
    `KNEE_CONCURRENCY="${knee != null ? knee : ''}"`,
    '',
  ].join('\n');

  const out = {};
  out[`results/${TEST_ID}/decision.env`] = lines;
  out.stdout = `eval after [${DONE.join(' ')}]: knee=${knee} signal=${signal} reached=${reached} confirmed=${confirmed}\n`;
  return out;
}
