// lib/util.js
// Shared helpers: duration parsing, workspace-name templating, TFE run-state
// grouping, and phase-duration derivation from run status-timestamps.

// Parse a k6-style duration ("15m", "90s", "1h", "30") into seconds.
export function parseDurationSeconds(d) {
  if (typeof d === 'number') return d;
  const m = /^(\d+)(s|m|h)?$/.exec(String(d).trim());
  if (!m) throw new Error(`bad duration: ${d}`);
  const n = Number(m[1]);
  if (m[2] === 'h') return n * 3600;
  if (m[2] === 'm') return n * 60;
  return n; // seconds (bare or "s")
}

// Render "k6cap-{test_id}-vu{vu}-{seq}" with a vars object.
export function renderName(tmpl, vars) {
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

// The substring of a name_template before the first {vu}/{seq} token, rendered
// with test_id — used as the cleanup prefix.
export function namePrefix(tmpl, testId) {
  const cut = tmpl.search(/\{(vu|seq)\}/);
  const head = cut >= 0 ? tmpl.slice(0, cut) : tmpl;
  return renderName(head, { test_id: testId });
}

// Run states grouped for capacity analysis (TFE Runs API 2.0.x).
export const QUEUED_STATES = [
  'pending', 'fetching', 'fetching_completed', 'queuing', 'plan_queued', 'apply_queued',
];
export const EXECUTING_STATES = [
  'pre_plan_running', 'planning', 'cost_estimating', 'policy_checking',
  'post_plan_running', 'applying',
];
export const NEEDS_ACTION_STATES = [
  'planned', 'cost_estimated', 'policy_checked', 'policy_override',
];
export const COMPLETED_STATES = ['applied', 'planned_and_finished'];
export const FAILED_STATES = [
  'errored', 'canceled', 'force_canceled', 'discarded', 'policy_soft_failed',
];
export const TERMINAL_STATES = [...COMPLETED_STATES, ...FAILED_STATES];
export const NON_FINAL_STATES = [
  ...QUEUED_STATES, ...EXECUTING_STATES, ...NEEDS_ACTION_STATES, 'confirmed',
];

export function isTerminal(s) { return TERMINAL_STATES.includes(s); }
export function isCompleted(s) { return COMPLETED_STATES.includes(s); }

// Phase durations (seconds) from run-level status-timestamps.
//
// IMPORTANT: the exact key set varies by TFE version and run path. These names
// follow go-tfe's RunStatusTimestamps (hyphenated). "planning-at" / "applying-at"
// (phase *start*) are the least certain — confirm against a real payload from
// your TFE. Each value is computed only when BOTH endpoints exist, else null, so
// a missing/renamed key degrades to null rather than producing a wrong number.
// For authoritative plan/apply *execution* durations you can alternatively read
// the Plan and Apply sub-resources (their status-timestamps have started-at /
// finished-at); left out here to keep the poll loop to one request per run.
function secsBetween(ts, aKey, bKey) {
  if (!ts) return null;
  const a = ts[aKey];
  const b = ts[bKey];
  if (!a || !b) return null;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

export function derivePhaseDurations(run, createdAtMs) {
  const ts = (run.attributes && run.attributes['status-timestamps']) || {};
  return {
    plan_queue:  secsBetween(ts, 'plan-queued-at', 'planning-at'),
    plan:        secsBetween(ts, 'planning-at', 'planned-at'),
    apply_queue: secsBetween(ts, 'apply-queued-at', 'applying-at'),
    apply:       secsBetween(ts, 'applying-at', 'applied-at'),
    // End-to-end from client-side create to now (terminal). Server timestamps are
    // preferred for phase splits above; total is only available client-side since
    // "created" isn't in status-timestamps.
    run: createdAtMs ? (Date.now() - createdAtMs) / 1000 : null,
  };
}
