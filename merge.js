// merge.js
// Folds the per-stage summaries into the final summary.json, labels each stage's
// regime (below/at config ceiling), and applies the knee heuristics. Pure k6 — no
// jq. Runs after all stages complete.
//
// Env: TEST_ID, TEST_DATA, CONCURRENCY_LIST, WARMUP_STAGE.

const TEST_DATA = JSON.parse(open(__ENV.TEST_DATA || './config/scenario.example.json'));
const TEST_ID = __ENV.TEST_ID;
const LIST = String(__ENV.CONCURRENCY_LIST || '')
  .trim().split(/\s+/).filter(Boolean).map(Number);
const WARMUP = __ENV.WARMUP_STAGE === '1';

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

function p95Run(s) {
  return s.durations_seconds && s.durations_seconds.run ? s.durations_seconds.run.p95 : null;
}

function analyze() {
  const oc = TEST_DATA.observed_config || {};
  const ceiling = (Number(oc.tfe_capacity_concurrency) || 0) * (Number(oc.terraform_enterprise_replicas) || 0);
  const sat = TEST_DATA.saturation || {};
  const gainFloor = Number(sat.throughput_gain_floor_pct != null ? sat.throughput_gain_floor_pct : 10);
  const p95Rise = Number(sat.p95_run_duration_rise_pct != null ? sat.p95_run_duration_rise_pct : 50);
  const failPct = Number(sat.failure_rate_pct != null ? sat.failure_rate_pct : 2);

  // Order by concurrency; first non-warmup stage is the baseline.
  const ordered = stages.slice().sort((a, b) => a.stage_concurrency - b.stage_concurrency);
  const scored = ordered.map((s, i) => {
    const created = s.runs.created || 0;
    const failed = s.runs.failed || 0;
    return Object.assign({}, s, {
      is_warmup: WARMUP && i === 0,
      regime: ceiling && s.stage_concurrency >= ceiling ? 'at_or_above_ceiling' : 'below_ceiling',
      failure_rate_pct: created > 0 ? Number(((failed / created) * 100).toFixed(2)) : 0,
    });
  });

  const measured = scored.filter((s) => !s.is_warmup);
  const baseline = measured[0] || null;
  const basep95 = baseline ? p95Run(baseline) : null;

  let knee = null;
  let signal = null;
  for (let i = 0; i < measured.length; i += 1) {
    const s = measured[i];
    const prev = measured[i - 1];

    if (s.failure_rate_pct > failPct) { knee = s.stage_concurrency; signal = 'failures'; break; }

    const sp95 = p95Run(s);
    if (basep95 && sp95 && (sp95 - basep95) / basep95 * 100 > p95Rise) {
      knee = s.stage_concurrency; signal = 'p95_run_duration_rise'; break;
    }
    if (prev && prev.throughput_completions_per_min && s.throughput_completions_per_min != null) {
      const gain = (s.throughput_completions_per_min - prev.throughput_completions_per_min)
        / prev.throughput_completions_per_min * 100;
      if (gain < gainFloor) { knee = prev.stage_concurrency; signal = 'throughput_plateau'; break; }
    }
  }

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

  const safe = knee ? Math.max(1, Math.floor(knee * 0.8)) : (measured.length ? measured[measured.length - 1].stage_concurrency : null);
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
    status: stages.length === LIST.length ? 'completed' : 'partial',
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
