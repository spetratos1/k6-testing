# Test Configuration Format

A capacity test is defined **entirely by one JSON scenario file** plus secrets passed as
environment variables. Defining or changing a test — the TFE target, the workload, the
concurrency ladder, thresholds, naming — requires **editing config only, no code changes**.

- **Authoritative schema:** [`config/scenario.schema.json`](../config/scenario.schema.json)
  (JSON Schema, draft 2020-12). This document is the human-readable companion to it.
- **Validation:** every run validates the scenario first (`validate.js`, wired into
  `run_test.sh`) and fails fast with field-level errors. Validate by hand with
  `k6 run validate.js -e TEST_DATA=config/my-scenario.json`.
- **Why JSON (not YAML):** k6 parses JSON natively (`open()` + `JSON.parse`) and has no built-in
  YAML, so the harness reads the scenario with zero extra dependencies.

## Rules
- **Secrets never live in the file.** Tokens are read from the env vars the file *names*
  (`tfe.token_env`, `tfe.admin_token_env`, `artifactory.token_env`).
- **Required top-level keys:** `test`, `tfe`, `workload`, `stages`, `observed_config`.
  Everything else is optional and has a default.
- **Unknown keys are rejected** (except inside `observed_config`, which is free-form) so typos
  surface instead of being silently ignored.
- **Durations** are k6-style strings: digits + optional `s`/`m`/`h` (bare = seconds): `30`, `90s`,
  `15m`, `1h`.

## Field reference

### `test` (required)
| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | — (required) | Scenario name, recorded in results. |
| `id_prefix` | string | `k6cap` | Informational label for the test family. |

### `tfe` (required)
| Field | Type | Default | Notes |
|---|---|---|---|
| `address` | string (https URI) | — (required) | TFE base URL. |
| `organization` | string | — (required) | Existing org the test workspaces are created in. |
| `tls_skip_verify` | boolean | `false` | Last resort only — prefer `SSL_CERT_FILE` with your private CA. |
| `token_env` | string | `TFE_TOKEN` | Env var holding the TFE token (must be able to **force-delete** workspaces). |
| `admin_token_env` | string | — | Env var holding a site-admin token; enables the observer's cluster-wide queue-depth sampling. Omitted → queue depth is skipped. |

### `artifactory` (optional)
| Field | Type | Default | Notes |
|---|---|---|---|
| `base_url` | string (URI) | — | Informational. |
| `token_env` | string | `ARTIFACTORY_TOKEN` | Env var for the tarball download bearer token. |

### `workload` (required)
| Field | Type | Default | Notes |
|---|---|---|---|
| `config` | string | — | Profile label (e.g. `state-heavy`, `noprov-light`). |
| `tarball_url` | string (URI) | — (required) | Artifactory URL of the prebuilt `.tar.gz` config slug. |
| `tarball_sha256` | string (64 hex) | — | If set, the wrapper **fails** when the download doesn't match. |
| `terraform_version` | string | — | Pinned on the workspace; must exist in the air-gapped TFE. |
| `auto_apply` | boolean | `true` | Exercise apply automatically after a successful plan. |
| `run_variables` | object (string→scalar) | `{}` | Terraform variables passed **per run**, so a scenario can tune the workload (e.g. `mock_count`, `hold_seconds`) without rebuilding the tarball. Captured in `summary.json`. Note: when set, the tarball sha256 no longer fully identifies the workload. |

### `workspace` (optional)
| Field | Type | Default | Notes |
|---|---|---|---|
| `name_template` | string | `k6cap-{test_id}-vu{vu}-{seq}` | **Must contain `{test_id}`** (cleanup/guard key). `{vu}`/`{seq}` keep each ephemeral workspace unique. Final name may use only letters, numbers, `-`, `_`. |
| `execution_mode` | enum `remote` | `remote` | Runs execute in TFE agent pods. |
| `delete_after_run` | boolean | `true` | Force-delete each workspace after its run. |

### `stages` (required)
| Field | Type | Default | Notes |
|---|---|---|---|
| `concurrency` | int[] (each ≥1) | — (required) | The ladder: execution concurrency (= k6 VUs) per stage. Include the config ceiling (`TFE_CAPACITY_CONCURRENCY × replicas`). First entry is the warmup/baseline when `warmup_stage` is true. |
| `return_to_baseline` | int ≥1 | — | Re-run this concurrency after the ladder to detect drift. |
| `dwell` | duration | `15m` | Steady-state hold per stage. |
| `warmup_stage` | boolean | `true` | Exclude the first stage from the knee calc. |
| `graceful_stop` | duration | `5m` | k6 `gracefulStop` per stage; set ≥ one full run lifecycle so in-flight runs finish and self-clean. |
| `min_completions_per_stage` | int ≥1 | `20` | Fewer measured completions → stage flagged as not steady. |

### `polling` (optional)
| Field | Type | Default | Notes |
|---|---|---|---|
| `run_interval` | duration | `5s` | How often each VU polls its run by ID. |
| `observer_interval` | duration | `5s` | How often the observer samples queue depth. |
| `run_deadline_factor` | number >0 | `3` | Watchdog: force-timeout a run after `factor × expected_run_duration`. |
| `expected_run_duration` | duration | `5m` | Expected single-run time; calibrate in an N=1 pilot. |

### `abort` (optional)
| Field | Type | Default | Notes |
|---|---|---|---|
| `failure_rate` | number 0–1 | `0.2` | k6 `abortOnFail`: stop the stage above this run failure rate. |
| `any_429` | boolean | `true` | Abort the stage on any HTTP 429 (rate-limited ⇒ invalid). |

### `saturation` (optional)
| Field | Type | Default | Notes |
|---|---|---|---|
| `throughput_gain_floor_pct` | number | `10` | Knee if added concurrency yields `<` this % more completion throughput. |
| `p95_run_duration_rise_pct` | number | `50` | Knee if p95 run duration rises `>` this % over baseline. |
| `queue_never_drains` | boolean | `true` | Treat a never-draining queue (below ceiling) as saturation. |
| `failure_rate_pct` | number | `2` | Knee if per-stage failure rate exceeds this %. |
| `stop_on_knee` | boolean | `false` | Halt the ladder once the knee is confirmed (one stage past it). |

### `observed_config` (required)
| Field | Type | Default | Notes |
|---|---|---|---|
| `tfe_capacity_concurrency` | int ≥1 | — (required) | `TFE_CAPACITY_CONCURRENCY` in effect (per pod). |
| `terraform_enterprise_replicas` | int ≥1 | — (required) | Number of `terraform-enterprise` pods. ceiling = concurrency × replicas. |

> Validation emits a **warning** (not an error) when the top stage exceeds the ceiling — a reminder
> to raise `TFE_CAPACITY_CONCURRENCY` for the saturation ladder, or queueing above the ceiling is
> forced by configuration rather than caused by resources.

## Minimal valid scenario
```json
{
  "test": { "name": "min" },
  "tfe": { "address": "https://tfe.example.internal", "organization": "platform-capacity" },
  "workload": { "tarball_url": "https://artifactory.example.internal/x/noprov-light-v1.tar.gz" },
  "stages": { "concurrency": [1, 2] },
  "observed_config": { "tfe_capacity_concurrency": 10, "terraform_enterprise_replicas": 3 }
}
```

## Ready-made examples
- [`config/examples/smoke-noprov.json`](../config/examples/smoke-noprov.json) — N=1,2 pilot on the
  no-provider profile; validate the lifecycle and freeze `status-timestamps` keys first.
- [`config/examples/full-ladder-early-stop.json`](../config/examples/full-ladder-early-stop.json) —
  full ladder with raised ceiling, run variables, return-to-baseline, and `stop_on_knee`.

## Precedence
Scenario file values are authoritative. The wrapper passes per-stage values to k6 via `-e`
(`CONCURRENCY`, `DWELL`, `GRACEFUL_STOP`, `STAGE_LABEL`, `TARBALL_PATH`), all derived from the file.
Secrets and `SSL_CERT_FILE` come from the environment. Nothing else is read from code.
