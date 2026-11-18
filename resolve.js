// resolve.js
// Reads the scenario JSON and emits a shell-sourceable env file so the bash
// wrapper never needs jq. Run once at the start of a test.
//
// Env: TEST_ID, TEST_DATA. Output: results/<TEST_ID>/resolved.env

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
  const lines = [
    `CONCURRENCY_LIST="${sh((s.concurrency || []).join(' '))}"`,
    `DWELL="${sh(s.dwell || '15m')}"`,
    `GRACEFUL_STOP="${sh(s.graceful_stop || '5m')}"`,
    `WARMUP_STAGE="${s.warmup_stage ? 1 : 0}"`,
    `TARBALL_URL="${sh(w.tarball_url || '')}"`,
    `TFE_ORG="${sh(TEST_DATA.tfe.organization || '')}"`,
    `TFE_ADDRESS="${sh(TEST_DATA.tfe.address || '')}"`,
    '',
  ].join('\n');

  const out = {};
  out[`results/${TEST_ID}/resolved.env`] = lines;
  out.stdout = `resolved ${(s.concurrency || []).length} stages for ${TEST_ID}\n`;
  return out;
}
