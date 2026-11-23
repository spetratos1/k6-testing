// resolve.js
// Reads the scenario JSON and emits a shell-sourceable env file so the bash
// wrapper never needs jq. Run once at the start of a test.
//
// Env: TEST_ID, TEST_DATA. Output: results/<TEST_ID>/resolved.env

import { namePrefix, basePrefix } from './lib/util.js';

const TEST_DATA = JSON.parse(open(__ENV.TEST_DATA || './config/scenario.example.json'));
const TEST_ID = __ENV.TEST_ID;

export const options = { vus: 1, iterations: 1 };

export default function () {
  // nothing to execute; all work happens in handleSummary (file write).
}

function sh(v) {
  return String(v).replace(/"/g, '\\"');
}

export function handleSummary() {
  const s = TEST_DATA.stages || {};
  const w = TEST_DATA.workload || {};
  const sat = TEST_DATA.saturation || {};
  const tmpl = (TEST_DATA.workspace && TEST_DATA.workspace.name_template) || 'k6cap-{test_id}-vu{vu}-{seq}';
  const lines = [
    `CONCURRENCY_LIST="${sh((s.concurrency || []).join(' '))}"`,
    `RETURN_TO_BASELINE="${sh(s.return_to_baseline || '')}"`,
    `STOP_ON_KNEE="${sat.stop_on_knee ? 1 : 0}"`,
    `DWELL="${sh(s.dwell || '15m')}"`,
    `GRACEFUL_STOP="${sh(s.graceful_stop || '5m')}"`,
    `WARMUP_STAGE="${s.warmup_stage ? 1 : 0}"`,
    `TARBALL_URL="${sh(w.tarball_url || '')}"`,
    `TARBALL_SHA256="${sh(w.tarball_sha256 || '')}"`,
    `TFE_ORG="${sh(TEST_DATA.tfe.organization || '')}"`,
    `TFE_ADDRESS="${sh(TEST_DATA.tfe.address || '')}"`,
    // base prefix (before {test_id}) for the startup guard
    `BASE_PREFIX="${sh(basePrefix(tmpl))}"`,
    `TEST_PREFIX="${sh(namePrefix(tmpl, TEST_ID))}"`,
    '',
  ].join('\n');

  const out = {};
  out[`results/${TEST_ID}/resolved.env`] = lines;
  out.stdout = `resolved ${(s.concurrency || []).length} stages for ${TEST_ID}\n`;
  return out;
}
