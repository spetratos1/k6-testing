// cleanup.js
// Two modes:
//   MODE=guard (default when set): READ-ONLY startup check. Lists all workspaces
//     from this harness (BASE_PREFIX) and fails if any belong to a DIFFERENT test
//     ID, so a new run never collides with leftovers from an old one.
//   otherwise: teardown / crash recovery. Finds every workspace for THIS test ID
//     (TFE is the inventory — no checkpoint file), cancels non-final runs, deletes.
// Safe to re-run.
//
// Env: TEST_ID, TEST_DATA, [PREFIX], [MODE=guard], [ALLOW_FOREIGN=1].
// Output: results/<TEST_ID>/cleanup.json (or guard.json).

import exec from 'k6/execution';
import { TFEClient } from './lib/tfe.js';
import { namePrefix, basePrefix, QUEUED_STATES, EXECUTING_STATES, NEEDS_ACTION_STATES } from './lib/util.js';

const TEST_DATA = JSON.parse(open(__ENV.TEST_DATA || './config/scenario.example.json'));
const TEST_ID = __ENV.TEST_ID;
const NAME_TMPL = TEST_DATA.workspace.name_template || 'k6cap-{test_id}-vu{vu}-{seq}';
const MODE = __ENV.MODE || 'cleanup';
const TEST_PREFIX = __ENV.PREFIX || namePrefix(NAME_TMPL, TEST_ID);
const BASE_PREFIX = basePrefix(NAME_TMPL);

const client = new TFEClient({
  address: TEST_DATA.tfe.address,
  tokenEnv: TEST_DATA.tfe.token_env,
});
const NONFINAL = [...QUEUED_STATES, ...EXECUTING_STATES, ...NEEDS_ACTION_STATES, 'confirmed'];

export const options = { vus: 1, iterations: 1 };

let report = { mode: MODE, prefix: TEST_PREFIX, found: 0, deleted: 0, canceled: 0, orphans: 0, foreign: [], ok: true };

function guard() {
  const wss = client.listWorkspacesByPrefix(TEST_DATA.tfe.organization, BASE_PREFIX);
  report.found = wss.length;
  report.foreign = wss
    .map((w) => w.attributes.name)
    .filter((n) => !String(n).startsWith(TEST_PREFIX));
  const allow = __ENV.ALLOW_FOREIGN === '1';
  report.ok = report.foreign.length === 0 || allow;
  console.log(JSON.stringify(Object.assign({ ev: 'guard' }, report)));
  if (!report.ok) {
    // non-zero exit so the wrapper (set -e) stops before creating anything.
    exec.test.abort(`foreign leftovers found: ${report.foreign.slice(0, 5).join(', ')} (set ALLOW_FOREIGN=1 to override)`);
  }
}

function teardown() {
  const wss = client.listWorkspacesByPrefix(TEST_DATA.tfe.organization, TEST_PREFIX);
  report.found = wss.length;
  for (const w of wss) {
    try {
      const active = client.listWorkspaceRunsByStatus(w.id, NONFINAL);
      for (const r of active) if (client.cancelRun(r.id)) report.canceled += 1;
      if (client.deleteWorkspace(w.id)) report.deleted += 1;
      else report.orphans += 1;
    } catch (e) {
      report.orphans += 1;
      console.log(JSON.stringify({ ev: 'cleanup_error', ws: w.id, err: String(e) }));
    }
  }
  report.ok = report.orphans === 0;
  console.log(JSON.stringify(Object.assign({ ev: 'cleanup' }, report)));
}

export default function () {
  if (MODE === 'guard') guard();
  else teardown();
}

export function handleSummary() {
  const out = {};
  const file = MODE === 'guard' ? 'guard.json' : 'cleanup.json';
  out[`results/${TEST_ID}/${file}`] = JSON.stringify(report, null, 2);
  out.stdout = MODE === 'guard'
    ? `guard: found=${report.found} foreign=${report.foreign.length} ok=${report.ok}\n`
    : `cleanup: found=${report.found} deleted=${report.deleted} canceled=${report.canceled} orphans=${report.orphans}\n`;
  return out;
}
