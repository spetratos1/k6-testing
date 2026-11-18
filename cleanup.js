// cleanup.js
// Standalone teardown / crash recovery. Finds every workspace whose name starts
// with the test prefix (TFE is the inventory — no checkpoint file needed),
// cancels any non-final run, and deletes the workspace. Safe to re-run.
//
// Env: TEST_ID, TEST_DATA, [PREFIX]. Output: results/<TEST_ID>/cleanup.json

import { TFEClient } from './lib/tfe.js';
import { namePrefix, QUEUED_STATES, EXECUTING_STATES, NEEDS_ACTION_STATES } from './lib/util.js';

const TEST_DATA = JSON.parse(open(__ENV.TEST_DATA || './config/scenario.example.json'));
const TEST_ID = __ENV.TEST_ID;
const NAME_TMPL = TEST_DATA.workspace.name_template || 'k6cap-{test_id}-vu{vu}-{seq}';
const PREFIX = __ENV.PREFIX || namePrefix(NAME_TMPL, TEST_ID);

const client = new TFEClient({ address: TEST_DATA.tfe.address });
const NONFINAL = [...QUEUED_STATES, ...EXECUTING_STATES, ...NEEDS_ACTION_STATES, 'confirmed'];

export const options = { vus: 1, iterations: 1 };

let report = { prefix: PREFIX, found: 0, deleted: 0, canceled: 0, orphans: 0, ok: true };

export default function () {
  const wss = client.listWorkspacesByPrefix(TEST_DATA.tfe.organization, PREFIX);
  report.found = wss.length;
  for (const w of wss) {
    try {
      const active = client.listWorkspaceRunsByStatus(w.id, NONFINAL);
      for (const r of active) {
        if (client.cancelRun(r.id)) report.canceled += 1;
      }
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

export function handleSummary() {
  const out = {};
  out[`results/${TEST_ID}/cleanup.json`] = JSON.stringify(report, null, 2);
  out.stdout = `cleanup: found=${report.found} deleted=${report.deleted} canceled=${report.canceled} orphans=${report.orphans}\n`;
  return out;
}
