// validate.js
// Validates a scenario file against the documented format (config/scenario.schema.json)
// using the pure checker in lib/validate-core.js — no external JSON-Schema library, so it
// runs air-gapped. Writes results/<id>/validation.json and aborts (non-zero exit) on any
// error, so run_test.sh fails fast on a bad config.
//
// Env: TEST_ID, TEST_DATA. Standalone: k6 run validate.js -e TEST_DATA=config/my.json

import exec from 'k6/execution';
import { validateScenario } from './lib/validate-core.js';

const TEST_DATA = JSON.parse(open(__ENV.TEST_DATA || './config/scenario.example.json'));
const TEST_ID = __ENV.TEST_ID || 'validate';

export const options = { vus: 1, iterations: 1 };

const { errors, warnings } = validateScenario(TEST_DATA);

export default function () {
  for (const w of warnings) console.log(JSON.stringify({ ev: 'validate_warn', msg: w }));
  for (const e of errors) console.log(JSON.stringify({ ev: 'validate_error', msg: e }));
  if (errors.length > 0) exec.test.abort(`invalid scenario: ${errors.length} error(s): ${errors.join('; ')}`);
}

export function handleSummary() {
  const report = { ok: errors.length === 0, errors, warnings };
  const out = {};
  out[`results/${TEST_ID}/validation.json`] = JSON.stringify(report, null, 2);
  out.stdout = report.ok
    ? `scenario valid (${warnings.length} warning(s))\n`
    : `scenario INVALID: ${errors.length} error(s)\n  - ${errors.join('\n  - ')}\n`;
  return out;
}
