// stage.js
// One concurrency STAGE = one `k6 run`. The closed-model `constant-vus` executor
// pins execution concurrency: 1 VU = 1 worker = 1 in-flight run, each with its
// own ephemeral workspace that is deleted after the run. A second 1-VU observer
// scenario samples server-side queue/executing depth.
//
// Env (set by run_test.sh): TEST_ID, TEST_DATA, CONCURRENCY, DWELL, GRACEFUL_STOP,
// TARBALL_PATH.

import { sleep } from 'k6';
import exec from 'k6/execution';
import { TFEClient } from './lib/tfe.js';
import * as M from './lib/metrics.js';
import {
  parseDurationSeconds, renderName, isTerminal, isCompleted,
  QUEUED_STATES, EXECUTING_STATES, derivePhaseDurations,
} from './lib/util.js';

// ---- init context ----
const TEST_DATA = JSON.parse(open(__ENV.TEST_DATA || './config/scenario.example.json'));
const TARBALL = open(__ENV.TARBALL_PATH, 'b'); // gzipped Terraform slug

const TEST_ID = __ENV.TEST_ID;
const CONCURRENCY = Number(__ENV.CONCURRENCY);
const DWELL = __ENV.DWELL || TEST_DATA.stages.dwell;
const GRACEFUL = __ENV.GRACEFUL_STOP || TEST_DATA.stages.graceful_stop || '5m';

const ORG = TEST_DATA.tfe.organization;
const NAME_TMPL = TEST_DATA.workspace.name_template || 'k6cap-{test_id}-vu{vu}-{seq}';
const EXEC_MODE = TEST_DATA.workspace.execution_mode || 'remote';
const DELETE_AFTER = TEST_DATA.workspace.delete_after_run !== false;
const AUTO_APPLY = TEST_DATA.workload.auto_apply !== false;

const RUN_INTERVAL = parseDurationSeconds((TEST_DATA.polling || {}).run_interval || '5s');
const OBS_INTERVAL = parseDurationSeconds((TEST_DATA.polling || {}).observer_interval || '5s');
const DEADLINE_FACTOR = Number((TEST_DATA.polling || {}).run_deadline_factor || 3);
const EXPECTED_RUN_S = parseDurationSeconds((TEST_DATA.polling || {}).expected_run_duration || '5m');
const CTAG = String(CONCURRENCY);

const client = new TFEClient({ address: TEST_DATA.tfe.address });
const seqByVu = {};

export const options = {
  insecureSkipTLSVerify: TEST_DATA.tfe.tls_skip_verify === true,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'],
  scenarios: {
    driver: {
      executor: 'constant-vus',
      vus: CONCURRENCY,
      duration: DWELL,
      gracefulStop: GRACEFUL, // let multi-minute runs finish + self-clean at stage end
      exec: 'driveRun',
    },
    observer: {
      executor: 'constant-vus',
      vus: 1,
      duration: DWELL,
      gracefulStop: '30s',
      exec: 'observe',
    },
  },
};

function logLine(obj) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), test_id: TEST_ID, c: CONCURRENCY }, obj)));
}

// ---- driver: one full run lifecycle per iteration ----
export function driveRun() {
  const vu = exec.vu.idInTest;
  seqByVu[vu] = (seqByVu[vu] || 0) + 1;
  const name = renderName(NAME_TMPL, { test_id: TEST_ID, vu, seq: seqByVu[vu] });

  let ws;
  try {
    ws = client.createWorkspace(ORG, name, { executionMode: EXEC_MODE, autoApply: AUTO_APPLY });
  } catch (e) {
    M.runsFailed.add(1, { reason: 'workspace_create', concurrency: CTAG });
    logLine({ ev: 'ws_create_error', name, err: String(e) });
    return;
  }

  const createdAt = Date.now();
  let finalStatus = 'unknown';
  try {
    const cv = client.createConfigurationVersion(ws.id, { autoQueueRuns: false });
    client.uploadConfiguration(cv.uploadURL, TARBALL);
    const run = client.createRun(ws.id, cv.id, { message: `k6 ${TEST_ID} c=${CONCURRENCY}` });
    M.runsCreated.add(1, { concurrency: CTAG });
    logLine({ ev: 'run_created', ws: ws.id, run: run.id, name });

    const deadlineMs = createdAt + DEADLINE_FACTOR * EXPECTED_RUN_S * 1000;
    let r = run;
    for (;;) {
      const st = r.attributes.status;
      if (!AUTO_APPLY && st === 'planned') client.applyRun(r.id);
      if (isTerminal(st)) { finalStatus = st; break; }
      if (Date.now() > deadlineMs) {
        client.cancelRun(r.id);
        finalStatus = 'timeout';
        logLine({ ev: 'run_timeout', ws: ws.id, run: run.id });
        break;
      }
      sleep(RUN_INTERVAL);
      r = client.readRun(run.id);
    }

    const d = derivePhaseDurations(r, createdAt);
    const tags = { concurrency: CTAG };
    if (d.plan_queue != null) M.planQueue.add(d.plan_queue, tags);
    if (d.plan != null) M.planDur.add(d.plan, tags);
    if (d.apply_queue != null) M.applyQueue.add(d.apply_queue, tags);
    if (d.apply != null) M.applyDur.add(d.apply, tags);
    if (d.run != null) M.runDur.add(d.run, tags);

    if (isCompleted(finalStatus)) {
      M.runsCompleted.add(1, tags);
    } else {
      M.runsFailed.add(1, Object.assign({ reason: finalStatus }, tags));
    }
    logLine({ ev: 'run_done', ws: ws.id, run: run.id, status: finalStatus, durations: d });
  } catch (e) {
    M.runsFailed.add(1, { reason: 'lifecycle_error', concurrency: CTAG });
    logLine({ ev: 'lifecycle_error', ws: ws && ws.id, err: String(e) });
  } finally {
    if (ws && DELETE_AFTER) {
      const ok = client.deleteWorkspace(ws.id);
      logLine({ ev: 'ws_deleted', ws: ws.id, ok });
    }
  }
}

// ---- observer: sample cluster-wide queue/executing depth (admin token) ----
export function observe() {
  const q = client.adminCountRunsByStatus(QUEUED_STATES);
  const x = client.adminCountRunsByStatus(EXECUTING_STATES);
  if (q >= 0) M.queueDepth.add(q, { concurrency: CTAG });
  if (x >= 0) M.execDepth.add(x, { concurrency: CTAG });
  if (q < 0) logLine({ ev: 'observer_unavailable', note: 'admin runs API not accessible (need admin token)' });
  sleep(OBS_INTERVAL);
}

// ---- per-stage result file (this is where metrics land, per requirement) ----
function trend(m, name) {
  const v = m[name] && m[name].values;
  if (!v) return null;
  return { avg: v.avg, med: v.med, p95: v['p(95)'], p99: v['p(99)'], min: v.min, max: v.max };
}
function count(m, name) {
  return (m[name] && m[name].values && m[name].values.count) || 0;
}

export function handleSummary(data) {
  const m = data.metrics || {};
  const dwellMin = parseDurationSeconds(DWELL) / 60;
  const completed = count(m, 'tfe_test_runs_completed_total');
  const stage = {
    stage_concurrency: CONCURRENCY,
    dwell: DWELL,
    generated_at: new Date().toISOString(),
    runs: {
      created: count(m, 'tfe_test_runs_created_total'),
      completed,
      failed: count(m, 'tfe_test_runs_failed_total'),
    },
    throughput_completions_per_min: dwellMin > 0 ? Number((completed / dwellMin).toFixed(3)) : null,
    durations_seconds: {
      plan_queue: trend(m, 'tfe_test_plan_queue_duration_seconds'),
      plan: trend(m, 'tfe_test_plan_duration_seconds'),
      apply_queue: trend(m, 'tfe_test_apply_queue_duration_seconds'),
      apply: trend(m, 'tfe_test_apply_duration_seconds'),
      run: trend(m, 'tfe_test_run_duration_seconds'),
    },
    queue_depth: trend(m, 'tfe_test_queue_depth'),
    executing_depth: trend(m, 'tfe_test_executing_depth'),
  };
  const out = {};
  out[`results/${TEST_ID}/summary-stage-${CONCURRENCY}.json`] = JSON.stringify(stage, null, 2);
  out.stdout = `stage c=${CONCURRENCY}: created=${stage.runs.created} completed=${completed} failed=${stage.runs.failed}\n`;
  return out;
}
