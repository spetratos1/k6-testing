// merge.js
// Folds the per-stage summaries into the final summary.json, labels each stage's
// regime (below/at config ceiling), and applies the knee heuristics. Pure k6 — no
// jq. Runs after all stages complete.
//
// Env: TEST_ID, TEST_DATA, CONCURRENCY_LIST, WARMUP_STAGE.

import { scoreStages, detectKnee, p95Run } from './lib/knee.js';

const TEST_DATA = JSON.parse(open(__ENV.TEST_DATA || './config/scenario.example.json'));
const TEST_ID = __ENV.TEST_ID;
const LIST = String(__ENV.CONCURRENCY_LIST || '')
  .trim().split(/\s+/).filter(Boolean).map(Number);
const WARMUP = __ENV.WARMUP_STAGE === '1';
const EARLY_STOP = __ENV.EARLY_STOP === '1';

// Load each per-stage file (init context; skip any that are missing).
const stages = [];
for (const c of LIST) {
  let raw = null;
  try { raw = open(`results/${TEST_ID}/${'summary-stage-'}${c}.json`); } catch (_) { raw = null; }
  if (raw) {
    try { stages.push(JSON.parse(raw)); } catch (_) { /* skip malformed */ }
  }
}

// Optional return-to-baseline stage (drift detection).
let returnStage = null;
try { returnStage = JSON.parse(open(`results/${TEST_ID}/summary-stage-baseline-return.json`)); } catch (_) { returnStage = null; }

export const options = { vus: 1, iterations: 1 };
export default function () {}

function analyze() {
  const oc = TEST_DATA.observed_config || {};
  const ceiling = (Number(oc.tfe_capacity_concurrency) || 0) * (Number(oc.terraform_enterprise_replicas) || 0);

  const scored = scoreStages(stages, { ceiling, warmup: WARMUP });
  const { knee, signal, safe } = detectKnee(scored, TEST_DATA.saturation || {});
  const measured = scored.filter((s) => !s.is_warmup);

  // Drift: compare the return-to-baseline stage against the same-concurrency
  // ladder stage. A slower return means something accumulated (DB/storage/pods).
  let drift = null;
  if (returnStage) {
    const match = measured.find((s) => s.stage_concurrency === returnStage.stage_concurrency);
    const a = match ? p95Run(match) : null;
    const b = p95Run(returnStage);
    drift = {
      concurrency: returnStage.stage_concurrency,
      initial_p95: a, return_p95: b,
      pct_change: (a && b) ? Number(((b - a) / a * 100).toFixed(1)) : null,
    };
  }

  let note = '';
  if (knee && ceiling) {
    note = knee >= ceiling
      ? `Knee at/above config ceiling (${ceiling}) => configuration-limited; raise TFE_CAPACITY_CONCURRENCY or replicas and re-test.`
      : `Knee below config ceiling (${ceiling}) => infrastructure-limited; correlate the stage window with Grafana to find the resource.`;
  }

  return { ceiling, scored, drift, result: {
    knee_concurrency: knee,
    limiting_signal: signal,
    safe_operating_concurrency: safe,
    baseline_drift: drift,
    notes: note,
  } };
}

export function handleSummary() {
  const a = analyze();
  const summary = {
    test_id: TEST_ID,
    schema_version: '1',
    status: EARLY_STOP ? 'stopped_knee' : (stages.length === LIST.length ? 'completed' : 'partial'),
    generated_at: new Date().toISOString(),
    tfe: {
      address: TEST_DATA.tfe.address,
      organization: TEST_DATA.tfe.organization,
    },
    observed_config: Object.assign({}, TEST_DATA.observed_config, { config_ceiling: a.ceiling }),
    workload: TEST_DATA.workload,
    stages: a.scored,
    return_to_baseline: returnStage,
    result: a.result,
  };
  const out = {};
  out[`results/${TEST_ID}/summary.json`] = JSON.stringify(summary, null, 2);
  out.stdout = `merged ${stages.length}/${LIST.length} stages -> results/${TEST_ID}/summary.json`
    + ` (knee=${a.result.knee_concurrency}, safe=${a.result.safe_operating_concurrency})\n`;
  return out;
}
