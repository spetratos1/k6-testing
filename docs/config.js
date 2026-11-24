// lib/config.js
// Scenario configuration: validate, apply defaults, derive k6 options.
// Pure ES module: no k6 or Node imports, so it runs in k6 init and in Node (tools/validate-scenario.mjs).
// Format reference: docs/test-configuration-format.md. Schema: schema/scenario.schema.json.

export const FORMAT_VERSION = 1;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const GRACEFUL_STOP_MARGIN_SEC = 120;

const DEFAULTS = {
  tfe: { tokenEnv: 'TFE_TOKEN' },
  workload: { runVariables: {} },
  workspaces: {
    namePrefix: 'tfcap', reuseWs: false, autoApply: true, executionMode: 'remote',
    deleteAfterRun: true, keepOnFailure: false,
  },
  polling: { intervalSec: 4, jitter: 0.25 },
  limits: { maxRunWaitSec: 1800, cancelBeforeDelete: true },
  saturation: {
    queueWaitP50Sec: 30, runDurationP95VsBaseline: 1.5, throughputEfficiencyMin: 0.8,
    failureRateMax: 0.01, minRunsPerStage: 20,
  },
  abort: { failureRate: 0.2, any429: true },
};
const STAGE_DEFAULTS = { role: 'ladder', rampSec: 60, warmupSec: 120 };

// Allowed keys per object, used to reject typos ("concurency") instead of ignoring them.
const KEYS = {
  root: ['scenario', 'version', 'description', 'tfe', 'workload', 'workspaces', 'polling', 'limits', 'stages', 'saturation', 'abort', 'grafana'],
  tfe: ['address', 'organization', 'tokenEnv', 'adminTokenEnv'],
  workload: ['artifactUrl', 'artifactSha256', 'artifactTokenEnv', 'terraformVersion', 'runVariables'],
  workspaces: ['namePrefix', 'reuseWs', 'autoApply', 'executionMode', 'deleteAfterRun', 'keepOnFailure'],
  polling: ['intervalSec', 'jitter'],
  limits: ['maxRunWaitSec', 'cancelBeforeDelete'],
  stage: ['name', 'role', 'concurrency', 'rampSec', 'warmupSec', 'holdSec'],
  saturation: ['queueWaitP50Sec', 'runDurationP95VsBaseline', 'throughputEfficiencyMin', 'failureRateMax', 'minRunsPerStage', 'baselineSummary'],
  abort: ['failureRate', 'any429'],
  grafana: ['address', 'tokenEnv', 'datasourceUid', 'annotate', 'collectInfra', 'queriesFile'],
};

const GRAFANA_DEFAULTS = {
  tokenEnv: 'GRAFANA_TOKEN', annotate: true, collectInfra: true,
  queriesFile: 'config/infra-queries.json',
};
// Grafana/Prometheus keep 12 h of metrics here; queries run after the test, so leave at least 1 h of margin.
const METRICS_RETENTION_SEC = 12 * 3600;
const METRICS_MARGIN_SEC = 3600;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function merge(defaults, given) {
  return Object.assign({}, defaults, isObj(given) ? given : {});
}

/**
 * Validate a parsed scenario object.
 * @returns {{ok: boolean, errors: string[], warnings: string[], config: object|null}}
 *          config is the object with defaults applied (null if there are errors).
 */
export function validateScenario(input) {
  const errors = [];
  const warnings = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);

  if (!isObj(input)) {
    return { ok: false, errors: ['(root): scenario must be a JSON object'], warnings, config: null };
  }

  function checkKeys(obj, allowed, path) {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) err(`${path}.${k}`, `unknown property (allowed: ${allowed.join(', ')})`);
    }
  }
  function req(obj, key, path, test, what) {
    if (obj[key] === undefined) return err(`${path}.${key}`, 'required');
    if (!test(obj[key])) err(`${path}.${key}`, `must be ${what}`);
  }
  function opt(obj, key, path, test, what) {
    if (obj[key] !== undefined && !test(obj[key])) err(`${path}.${key}`, `must be ${what}`);
  }
  const str = (v) => typeof v === 'string' && v.length > 0;
  const re = (rx) => (v) => typeof v === 'string' && rx.test(v);
  const bool = (v) => typeof v === 'boolean';
  const range = (lo, hi) => (v) => isNum(v) && v >= lo && v <= hi;
  const intRange = (lo, hi) => (v) => isInt(v) && v >= lo && v <= hi;

  checkKeys(input, KEYS.root, '$');
  req(input, 'scenario', '$', re(/^[a-z0-9][a-z0-9-]{0,39}$/), 'lowercase letters, digits and hyphens (max 40)');
  if (input.version !== FORMAT_VERSION) err('$.version', `must be ${FORMAT_VERSION}`);
  opt(input, 'description', '$', (v) => typeof v === 'string' && v.length <= 500, 'a string up to 500 characters');

  // tfe
  const tfe = isObj(input.tfe) ? input.tfe : (err('$.tfe', 'required object'), {});
  checkKeys(tfe, KEYS.tfe, '$.tfe');
  req(tfe, 'address', '$.tfe', re(/^https?:\/\/[^\s/]+(:[0-9]+)?\/?$/), 'a base URL such as https://tfe.example.internal (no path)');
  req(tfe, 'organization', '$.tfe', str, 'a non-empty string');
  opt(tfe, 'tokenEnv', '$.tfe', re(ENV_NAME), 'an environment variable name');
  opt(tfe, 'adminTokenEnv', '$.tfe', re(ENV_NAME), 'an environment variable name');

  // workload
  const wl = isObj(input.workload) ? input.workload : (err('$.workload', 'required object'), {});
  checkKeys(wl, KEYS.workload, '$.workload');
  req(wl, 'artifactUrl', '$.workload', re(/^https?:\/\/\S+\.(tar\.gz|tgz)$/), 'an http(s) link to a .tar.gz archive');
  opt(wl, 'artifactSha256', '$.workload', re(/^[a-f0-9]{64}$/), '64 lowercase hex characters');
  opt(wl, 'artifactTokenEnv', '$.workload', re(ENV_NAME), 'an environment variable name');
  req(wl, 'terraformVersion', '$.workload', re(/^[0-9]+\.[0-9]+\.[0-9]+$/), 'an exact version such as 1.9.8');
  if (wl.runVariables !== undefined) {
    if (!isObj(wl.runVariables)) err('$.workload.runVariables', 'must be an object');
    else {
      for (const [k, v] of Object.entries(wl.runVariables)) {
        if (!re(/^[A-Za-z_][A-Za-z0-9_]*$/)(k)) err(`$.workload.runVariables.${k}`, 'not a valid Terraform variable name');
        if (!['string', 'number', 'boolean'].includes(typeof v)) err(`$.workload.runVariables.${k}`, 'must be a string, number or boolean');
      }
    }
  }

  // workspaces
  const ws = input.workspaces === undefined ? {} : input.workspaces;
  if (!isObj(ws)) err('$.workspaces', 'must be an object');
  else {
    checkKeys(ws, KEYS.workspaces, '$.workspaces');
    opt(ws, 'namePrefix', '$.workspaces', re(/^[A-Za-z0-9_-]{1,20}$/), 'letters, digits, hyphen, underscore (max 20)');
    opt(ws, 'reuseWs', '$.workspaces', bool, 'a boolean');
    if (ws.autoApply !== undefined && ws.autoApply !== true) err('$.workspaces.autoApply', 'format version 1 supports only true');
    if (ws.executionMode !== undefined && ws.executionMode !== 'remote') err('$.workspaces.executionMode', 'format version 1 supports only "remote"');
    opt(ws, 'deleteAfterRun', '$.workspaces', bool, 'a boolean');
    opt(ws, 'keepOnFailure', '$.workspaces', bool, 'a boolean');
  }

  // polling
  const pl = input.polling === undefined ? {} : input.polling;
  if (!isObj(pl)) err('$.polling', 'must be an object');
  else {
    checkKeys(pl, KEYS.polling, '$.polling');
    opt(pl, 'intervalSec', '$.polling', range(1, 60), 'a number from 1 to 60');
    opt(pl, 'jitter', '$.polling', range(0, 1), 'a number from 0 to 1');
  }

  // limits
  const lim = input.limits === undefined ? {} : input.limits;
  if (!isObj(lim)) err('$.limits', 'must be an object');
  else {
    checkKeys(lim, KEYS.limits, '$.limits');
    opt(lim, 'maxRunWaitSec', '$.limits', intRange(60, 86400), 'an integer from 60 to 86400');
    opt(lim, 'cancelBeforeDelete', '$.limits', bool, 'a boolean');
  }

  // stages
  const stages = [];
  if (!Array.isArray(input.stages) || input.stages.length < 1 || input.stages.length > 30) {
    err('$.stages', 'required array with 1 to 30 stages');
  } else {
    input.stages.forEach((s, i) => {
      const p = `$.stages[${i}]`;
      if (!isObj(s)) return err(p, 'must be an object');
      checkKeys(s, KEYS.stage, p);
      req(s, 'name', p, re(/^[a-z0-9][a-z0-9_-]{0,19}$/), 'lowercase letters, digits, - or _ (max 20)');
      opt(s, 'role', p, (v) => ['baseline', 'ladder', 'return'].includes(v), 'one of baseline, ladder, return');
      req(s, 'concurrency', p, intRange(1, 500), 'an integer from 1 to 500');
      opt(s, 'rampSec', p, intRange(0, 86400), 'an integer >= 0');
      opt(s, 'warmupSec', p, intRange(0, 86400), 'an integer >= 0');
      req(s, 'holdSec', p, intRange(1, 86400), 'an integer >= 1');
      stages.push(merge(STAGE_DEFAULTS, s));
    });
  }

  // saturation
  const sat = input.saturation === undefined ? {} : input.saturation;
  if (!isObj(sat)) err('$.saturation', 'must be an object');
  else {
    checkKeys(sat, KEYS.saturation, '$.saturation');
    opt(sat, 'queueWaitP50Sec', '$.saturation', (v) => isNum(v) && v > 0, 'a number > 0');
    opt(sat, 'runDurationP95VsBaseline', '$.saturation', (v) => isNum(v) && v > 1, 'a number > 1');
    opt(sat, 'throughputEfficiencyMin', '$.saturation', (v) => isNum(v) && v > 0 && v <= 1, 'a number in (0, 1]');
    opt(sat, 'failureRateMax', '$.saturation', range(0, 1), 'a number from 0 to 1');
    opt(sat, 'minRunsPerStage', '$.saturation', intRange(1, 1000000), 'an integer >= 1');
    opt(sat, 'baselineSummary', '$.saturation', str, 'a path string');
  }

  // abort
  const ab = input.abort === undefined ? {} : input.abort;
  if (!isObj(ab)) err('$.abort', 'must be an object');
  else {
    checkKeys(ab, KEYS.abort, '$.abort');
    opt(ab, 'failureRate', '$.abort', (v) => isNum(v) && v > 0 && v <= 1, 'a number in (0, 1]');
    opt(ab, 'any429', '$.abort', bool, 'a boolean');
  }

  // grafana (optional block; absent = Grafana features off)
  let gf = null;
  if (input.grafana !== undefined) {
    if (!isObj(input.grafana)) err('$.grafana', 'must be an object');
    else {
      gf = input.grafana;
      checkKeys(gf, KEYS.grafana, '$.grafana');
      req(gf, 'address', '$.grafana', re(/^https?:\/\/[^\s/]+(:[0-9]+)?\/?$/), 'a base URL such as https://grafana.example.internal (no path)');
      opt(gf, 'tokenEnv', '$.grafana', re(ENV_NAME), 'an environment variable name');
      opt(gf, 'datasourceUid', '$.grafana', str, 'a non-empty string');
      opt(gf, 'annotate', '$.grafana', bool, 'a boolean');
      opt(gf, 'collectInfra', '$.grafana', bool, 'a boolean');
      opt(gf, 'queriesFile', '$.grafana', str, 'a path string');
      const collect = gf.collectInfra === undefined ? true : gf.collectInfra;
      if (collect === true && !str(gf.datasourceUid)) {
        err('$.grafana.datasourceUid', 'required when collectInfra is true (set collectInfra to false to only annotate)');
      }
    }
  }

  // cross-field rules (not expressible in JSON Schema)
  if (stages.length > 0 && errors.length === 0) {
    const names = new Set();
    stages.forEach((s, i) => {
      if (names.has(s.name)) err(`$.stages[${i}].name`, `duplicate stage name "${s.name}"`);
      names.add(s.name);
    });
    const baselines = stages.filter((s) => s.role === 'baseline');
    const ladder = stages.filter((s) => s.role === 'ladder');
    const returns = stages.filter((s) => s.role === 'return');
    if (baselines.length > 1) err('$.stages', 'at most one stage may have role "baseline"');
    if (baselines.length === 1 && stages[0].role !== 'baseline') err('$.stages', 'the baseline stage must come first');
    if (returns.length > 0 && ladder.length > 0) {
      err('$.stages', 'a "return" stage must be run in its own invocation, not together with "ladder" stages (see design section 5)');
    }
    for (let i = 1; i < stages.length; i++) {
      if (stages[i].concurrency < stages[i - 1].concurrency) {
        err(`$.stages[${i}].concurrency`, 'must not be lower than the previous stage (the target never goes down within one invocation)');
      }
    }
    ladder.forEach((s, i) => {
      if (i > 0 && s.concurrency <= ladder[i - 1].concurrency) {
        err(`$.stages`, `ladder stage "${s.name}" must have a higher concurrency than "${ladder[i - 1].name}"`);
      }
    });
    const sats = merge(DEFAULTS.saturation, sat);
    if (baselines.length === 0 && !sats.baselineSummary) {
      warnings.push('no baseline stage and no saturation.baselineSummary: signal S2 (run duration vs baseline) and S3 cannot be evaluated');
    }
    const lm = merge(DEFAULTS.limits, lim);
    stages.forEach((s) => {
      if (s.holdSec < lm.maxRunWaitSec) {
        warnings.push(`stage "${s.name}": holdSec (${s.holdSec}) is shorter than limits.maxRunWaitSec (${lm.maxRunWaitSec}); slow runs may not finish inside the window`);
      }
    });
  }

  if (errors.length === 0 && gf && gf.collectInfra !== false) {
    const lm = merge(DEFAULTS.limits, lim);
    const total = stages.reduce((a, x) => a + x.rampSec + x.warmupSec + x.holdSec, 0) + lm.maxRunWaitSec;
    if (total > METRICS_RETENTION_SEC - METRICS_MARGIN_SEC) {
      warnings.push(`scenario plus drain is ${(total / 3600).toFixed(1)} h; metrics are kept ${METRICS_RETENTION_SEC / 3600} h, so early stages may be gone when postprocess queries them`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings, config: null };

  const config = {
    scenario: input.scenario,
    version: input.version,
    description: input.description || '',
    tfe: merge(DEFAULTS.tfe, tfe),
    workload: merge(DEFAULTS.workload, wl),
    workspaces: merge(DEFAULTS.workspaces, ws),
    polling: merge(DEFAULTS.polling, pl),
    limits: merge(DEFAULTS.limits, lim),
    stages,
    saturation: merge(DEFAULTS.saturation, sat),
    abort: merge(DEFAULTS.abort, ab),
    grafana: gf ? merge(GRAFANA_DEFAULTS, gf) : null,
  };
  config.tfe.address = config.tfe.address.replace(/\/$/, '');
  if (config.grafana) config.grafana.address = config.grafana.address.replace(/\/$/, '');
  return { ok: true, errors, warnings, config };
}

/**
 * Apply per-invocation overrides from environment values (k6: __ENV).
 * Only REUSE_WS may change the scenario; TEST_ID and SCENARIO are read by main.js / run.sh.
 */
export function applyEnvOverrides(config, env) {
  const out = JSON.parse(JSON.stringify(config));
  const v = env && env.REUSE_WS;
  if (v !== undefined && v !== '') {
    if (v !== 'true' && v !== 'false') throw new Error(`REUSE_WS must be "true" or "false", got "${v}"`);
    out.workspaces.reuseWs = v === 'true';
  }
  return out;
}

/** Names of environment variables that must be set, with the reason. */
export function requiredEnv(config) {
  const need = [{ name: config.tfe.tokenEnv, why: 'TFE API token' }];
  if (config.workload.artifactTokenEnv) need.push({ name: config.workload.artifactTokenEnv, why: 'Artifactory token' });
  return need;
}

/** Optional env vars (feature is off when missing). */
export function optionalEnv(config) {
  const out = [];
  if (config.tfe.adminTokenEnv) out.push({ name: config.tfe.adminTokenEnv, why: 'admin queue and force-cancel calls' });
  if (config.grafana) out.push({ name: config.grafana.tokenEnv, why: 'Grafana metrics and annotations (skipped if unset)' });
  return out;
}

/**
 * Derive everything k6 needs from the validated scenario.
 * Stage windows are offsets in seconds from the start of the main scenario.
 */
export function derive(config) {
  let t = 0;
  const windows = config.stages.map((s) => {
    const startSec = t;
    const rampEndSec = startSec + s.rampSec;
    const measureStartSec = rampEndSec + s.warmupSec;
    const endSec = measureStartSec + s.holdSec;
    t = endSec;
    return {
      name: s.name, role: s.role, concurrency: s.concurrency,
      startSec, rampEndSec, measureStartSec, endSec, measureSec: s.holdSec,
    };
  });
  const maxConcurrency = Math.max(...config.stages.map((s) => s.concurrency));

  // k6 ramping-vus: ramp to the target over rampSec, then hold for warmupSec + holdSec.
  const k6Stages = [];
  for (const s of config.stages) {
    if (s.rampSec > 0) k6Stages.push({ duration: `${s.rampSec}s`, target: s.concurrency });
    else k6Stages.push({ duration: '1s', target: s.concurrency });
    k6Stages.push({ duration: `${s.warmupSec + s.holdSec}s`, target: s.concurrency });
  }

  const poolSize = config.workspaces.reuseWs ? maxConcurrency : 0;
  const setupSec = Math.max(60, poolSize * 5 + 60);
  const teardownSec = Math.max(60, maxConcurrency * 5 + 60);

  // Tagged sub-metrics only appear in the k6 summary when a threshold exists on them [V].
  const thresholds = {};
  const trendMetrics = [
    'tfe_test_pending_seconds', 'tfe_test_plan_queue_seconds', 'tfe_test_plan_seconds',
    'tfe_test_apply_queue_seconds', 'tfe_test_apply_seconds', 'tfe_test_run_duration_seconds',
  ];
  for (const w of windows) {
    for (const m of trendMetrics) thresholds[`${m}{stage:${w.name},phase:measure}`] = ['max>=0'];
    thresholds[`tfe_test_run_failed{stage:${w.name},phase:measure}`] = ['rate>=0'];
  }
  thresholds['tfe_test_run_failed'] = [{
    threshold: `rate<${config.abort.failureRate}`, abortOnFail: true, delayAbortEval: '60s',
  }];
  if (config.abort.any429) {
    thresholds['tfe_test_api_429'] = [{ threshold: 'count<1', abortOnFail: true }];
  }

  return {
    maxConcurrency,
    poolSize,
    totalDurationSec: t,
    windows,
    k6Options: {
      scenarios: {
        tfe_capacity: {
          executor: 'ramping-vus',
          startVUs: 0,
          stages: k6Stages,
          gracefulStop: `${config.limits.maxRunWaitSec + GRACEFUL_STOP_MARGIN_SEC}s`,
          gracefulRampDown: '0s',
        },
      },
      thresholds,
      setupTimeout: `${setupSec}s`,
      teardownTimeout: `${teardownSec}s`,
      summaryTrendStats: ['count', 'min', 'med', 'p(90)', 'p(95)', 'max'],
      noConnectionReuse: false,
    },
  };
}

/**
 * Which stage and phase is a VU in at `elapsedSec` since scenario start?
 * Returns null after the last window (drain phase: runs are not counted).
 * phase: 'ramp' | 'warmup' | 'measure'
 */
export function stageAt(windows, elapsedSec) {
  for (const w of windows) {
    if (elapsedSec < w.endSec) {
      const phase = elapsedSec < w.rampEndSec ? 'ramp' : elapsedSec < w.measureStartSec ? 'warmup' : 'measure';
      return { stage: w.name, role: w.role, concurrency: w.concurrency, phase };
    }
  }
  return null;
}

/** Workspace name for an iteration: identifies the test, prefix-testid-vu-iter. */
export function workspaceName(config, testId, vu, iter) {
  const id = String(testId).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${config.workspaces.namePrefix}-${id}-v${vu}-i${iter}`;
}

/** Prefix shared by every workspace of one test; used by cleanup.js with search[wildcard-name]. */
export function testWorkspacePrefix(config, testId) {
  const id = String(testId).toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${config.workspaces.namePrefix}-${id}-`;
}

/** Load, validate, apply overrides and derive. Throws one Error listing all problems. */
export function loadScenario(rawText, env) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`scenario is not valid JSON: ${e.message}`);
  }
  const res = validateScenario(parsed);
  if (!res.ok) throw new Error(`invalid scenario:\n  - ${res.errors.join('\n  - ')}`);
  const config = applyEnvOverrides(res.config, env || {});
  return { config, derived: derive(config), warnings: res.warnings };
}
