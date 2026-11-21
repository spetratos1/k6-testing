// lib/validate-core.js
// Pure scenario validation (no k6 imports) so it is unit-testable and shared.
// Mirrors config/scenario.schema.json. Returns { errors, warnings } (arrays of strings).

const DUR = /^[0-9]+(s|m|h)?$/;

export function validateScenario(d) {
  const errors = [];
  const warnings = [];
  const err = (p, m) => errors.push(`${p}: ${m}`);
  const warn = (p, m) => warnings.push(`${p}: ${m}`);
  const has = (o, k) => o && Object.prototype.hasOwnProperty.call(o, k);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const reqStr = (o, p, k) => { if (!has(o, k) || typeof o[k] !== 'string' || o[k].length === 0) err(`${p}.${k}`, 'required non-empty string'); };
  const optType = (o, p, k, t) => { if (has(o, k) && typeof o[k] !== t) err(`${p}.${k}`, `must be ${t}`); };
  const optDur = (o, p, k) => { if (has(o, k) && !(typeof o[k] === 'string' && DUR.test(o[k]))) err(`${p}.${k}`, 'must be a duration like 15m/90s/1h'); };
  const optPosInt = (o, p, k) => { if (has(o, k) && (!Number.isInteger(o[k]) || o[k] < 1)) err(`${p}.${k}`, 'must be an integer >= 1'); };

  if (!isObj(d)) { err('(root)', 'must be a JSON object'); return { errors, warnings }; }

  if (!has(d, 'version')) err('version', 'required: must be 1');
  else if (d.version !== 1) err('version', 'must be 1 (this validator is for format version 1)');

  if (!isObj(d.test)) err('test', 'required object'); else reqStr(d.test, 'test', 'name');

  if (!isObj(d.tfe)) { err('tfe', 'required object'); } else {
    reqStr(d.tfe, 'tfe', 'address');
    if (has(d.tfe, 'address') && typeof d.tfe.address === 'string' && !/^https:\/\//.test(d.tfe.address)) err('tfe.address', 'must start with https://');
    reqStr(d.tfe, 'tfe', 'organization');
    optType(d.tfe, 'tfe', 'tls_skip_verify', 'boolean');
    optType(d.tfe, 'tfe', 'token_env', 'string');
    optType(d.tfe, 'tfe', 'admin_token_env', 'string');
    if (!has(d.tfe, 'admin_token_env')) warn('tfe.admin_token_env', 'not set: observer queue-depth sampling will be skipped');
  }

  if (!isObj(d.workload)) { err('workload', 'required object'); } else {
    reqStr(d.workload, 'workload', 'tarball_url');
    if (has(d.workload, 'tarball_sha256') && d.workload.tarball_sha256 !== '' && !/^[0-9a-f]{64}$/.test(String(d.workload.tarball_sha256))) err('workload.tarball_sha256', 'must be a 64-char hex sha256 (or empty)');
    optType(d.workload, 'workload', 'auto_apply', 'boolean');
    if (has(d.workload, 'run_variables') && !isObj(d.workload.run_variables)) err('workload.run_variables', 'must be an object of key->value');
  }

  if (has(d, 'workspace')) {
    const w = d.workspace;
    if (!isObj(w)) err('workspace', 'must be an object');
    else {
      if (has(w, 'name_template')) {
        if (typeof w.name_template !== 'string') err('workspace.name_template', 'must be a string');
        else if (w.name_template.indexOf('{test_id}') < 0) err('workspace.name_template', 'must contain {test_id} (needed for cleanup/guard)');
      }
      if (has(w, 'execution_mode') && w.execution_mode !== 'remote') err('workspace.execution_mode', 'only "remote" is supported');
      optType(w, 'workspace', 'delete_after_run', 'boolean');
    }
  }

  if (!isObj(d.stages)) { err('stages', 'required object'); } else {
    const s = d.stages;
    if (!Array.isArray(s.concurrency) || s.concurrency.length < 1) err('stages.concurrency', 'required non-empty array of integers >= 1');
    else {
      const seen = {};
      s.concurrency.forEach((c, i) => {
        if (!Number.isInteger(c) || c < 1) err(`stages.concurrency[${i}]`, 'must be an integer >= 1');
        // Per-stage summaries are keyed by concurrency, so duplicates would collide.
        else if (seen[c]) err(`stages.concurrency[${i}]`, `duplicate concurrency ${c} (stage summary files are keyed by concurrency)`);
        else seen[c] = true;
      });
      for (let i = 1; i < s.concurrency.length; i += 1) {
        if (s.concurrency[i] <= s.concurrency[i - 1]) { warn('stages.concurrency', 'not strictly increasing; a capacity ladder is usually ascending'); break; }
      }
    }
    optPosInt(s, 'stages', 'return_to_baseline');
    optDur(s, 'stages', 'dwell');
    optDur(s, 'stages', 'graceful_stop');
    optType(s, 'stages', 'warmup_stage', 'boolean');
    optPosInt(s, 'stages', 'min_completions_per_stage');

    const oc = d.observed_config || {};
    const ceiling = (Number(oc.tfe_capacity_concurrency) || 0) * (Number(oc.terraform_enterprise_replicas) || 0);
    const top = Array.isArray(s.concurrency) && s.concurrency.length ? Math.max.apply(null, s.concurrency) : 0;
    if (ceiling && top > ceiling) warn('stages.concurrency', `top stage ${top} exceeds the config ceiling ${ceiling}; raise TFE_CAPACITY_CONCURRENCY for the saturation ladder`);
  }

  if (has(d, 'polling')) {
    const p = d.polling;
    optDur(p, 'polling', 'run_interval');
    optDur(p, 'polling', 'observer_interval');
    optDur(p, 'polling', 'expected_run_duration');
    if (has(p, 'run_deadline_factor') && (typeof p.run_deadline_factor !== 'number' || p.run_deadline_factor <= 0)) err('polling.run_deadline_factor', 'must be a positive number');
  }

  if (has(d, 'abort')) {
    if (has(d.abort, 'failure_rate') && (typeof d.abort.failure_rate !== 'number' || d.abort.failure_rate < 0 || d.abort.failure_rate > 1)) err('abort.failure_rate', 'must be a number in [0, 1]');
    optType(d.abort, 'abort', 'any_429', 'boolean');
  }

  if (has(d, 'saturation')) {
    optType(d.saturation, 'saturation', 'stop_on_knee', 'boolean');
    ['throughput_gain_floor_pct', 'p95_run_duration_rise_pct', 'failure_rate_pct'].forEach((k) => {
      if (has(d.saturation, k) && typeof d.saturation[k] !== 'number') err(`saturation.${k}`, 'must be a number');
    });
  }

  if (!isObj(d.observed_config)) err('observed_config', 'required object'); else {
    if (!has(d.observed_config, 'tfe_capacity_concurrency')) err('observed_config.tfe_capacity_concurrency', 'required integer >= 1');
    else optPosInt(d.observed_config, 'observed_config', 'tfe_capacity_concurrency');
    if (!has(d.observed_config, 'terraform_enterprise_replicas')) err('observed_config.terraform_enterprise_replicas', 'required integer >= 1');
    else optPosInt(d.observed_config, 'observed_config', 'terraform_enterprise_replicas');
  }

  if (has(d, 'grafana')) {
    const g = d.grafana;
    if (!isObj(g)) err('grafana', 'must be an object');
    else {
      optType(g, 'grafana', 'enabled', 'boolean');
      optType(g, 'grafana', 'token_env', 'string');
      optType(g, 'grafana', 'datasource_uid', 'string');
      if (g.enabled === true) {
        if (!has(g, 'base_url') || typeof g.base_url !== 'string') err('grafana.base_url', 'required when grafana.enabled is true');
      }
      if (has(g, 'metrics')) {
        if (!Array.isArray(g.metrics)) err('grafana.metrics', 'must be an array');
        else g.metrics.forEach((m, i) => {
          if (!isObj(m) || typeof m.name !== 'string' || typeof m.expr !== 'string') err(`grafana.metrics[${i}]`, 'needs string name and expr');
          if (has(m, 'stat') && !['avg', 'max', 'p95'].includes(m.stat)) err(`grafana.metrics[${i}].stat`, 'must be avg|max|p95');
        });
      }
    }
  }

  if (has(d, 'retention')) {
    const r = d.retention;
    if (!isObj(r)) err('retention', 'must be an object');
    else {
      if (has(r, 'keep_raw_days') && (!Number.isInteger(r.keep_raw_days) || r.keep_raw_days < 0)) err('retention.keep_raw_days', 'must be an integer >= 0');
      optPosInt(r, 'retention', 'max_local_tests');
      optType(r, 'retention', 'compress_raw', 'boolean');
      if (has(r, 'grafana_annotations') && !/^(keep|delete_after_days:[0-9]+)$/.test(String(r.grafana_annotations))) err('retention.grafana_annotations', 'must be "keep" or "delete_after_days:N"');
    }
  }

  return { errors, warnings };
}
