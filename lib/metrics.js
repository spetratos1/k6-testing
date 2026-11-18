// lib/metrics.js
// Custom metrics — ONLY k6-supported types (Counter, Trend). k6 has no histogram
// type, so durations use Trend (min/med/avg/p95/p99/max). Every metric here is
// surfaced in the result file via stage.js handleSummary().

import { Counter, Trend, Rate } from 'k6/metrics';

// Counts (monotonic). rate of completed = throughput, the primary knee signal.
export const runsCreated   = new Counter('tfe_test_runs_created_total');
export const runsCompleted = new Counter('tfe_test_runs_completed_total');
export const runsFailed    = new Counter('tfe_test_runs_failed_total'); // tag reason=...

// Safety-abort drivers (v2 review): a failure Rate and a 429 counter so k6 can
// hard-stop a stage via abortOnFail thresholds.
export const runFailedRate = new Rate('tfe_test_run_failed');  // 1 = errored/timeout
export const api429        = new Counter('tfe_test_api_429');  // incremented in lib/tfe.js

// Phase durations (seconds), derived from run status-timestamps.
export const planQueue  = new Trend('tfe_test_plan_queue_duration_seconds');
export const planDur    = new Trend('tfe_test_plan_duration_seconds');
export const applyQueue = new Trend('tfe_test_apply_queue_duration_seconds');
export const applyDur   = new Trend('tfe_test_apply_duration_seconds');
export const runDur     = new Trend('tfe_test_run_duration_seconds');

// Depth gauges sampled by the observer scenario. Trend (not Gauge) so the result
// file keeps avg/max/p95 across the stage instead of only the last value.
export const queueDepth = new Trend('tfe_test_queue_depth');
export const execDepth  = new Trend('tfe_test_executing_depth');
