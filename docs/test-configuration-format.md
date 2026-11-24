# Test configuration format (version 1)

A **scenario file** is a JSON document that fully describes one k6 invocation of the TFE capacity test: which TFE and organization to hit, which prebuilt configuration archive to run, how workspaces are handled, and the stages (concurrency steps) with their saturation and abort rules. To run a different test you write a different scenario file. You do not edit `main.js` or `lib/*.js`.

JSON is used because k6 cannot parse YAML. The file is read with k6's `open()` in the init stage, so there are no comments; use the `description` field.

- Machine-readable schema: `schema/scenario.schema.json` (JSON Schema 2020-12, for editor validation).
- Executable validator: `lib/config.js`, the same code `main.js` runs at startup.
- Examples: `scenarios/*.example.json`.

## Quick start

1. Copy the closest example, for example `cp scenarios/pilot.example.json scenarios/my-test.json`.
2. Edit the values (address, organization, artifact link, stages).
3. Check it without touching TFE:

   ```
   node tools/validate-scenario.mjs scenarios/my-test.json
   ```

   This prints the stage timeline, total duration, the environment variables you must set, and warnings. It exits non-zero and lists **all** problems if the file is invalid. (Node is needed only for this check; k6 runs the same validation at startup and refuses to start on an invalid file.)
4. Export the secrets named in the file (`TFE_TOKEN`, and `ARTIFACTORY_TOKEN` if used), then run through the wrapper (`run.sh`, see the design document, section 1).

## Per-invocation overrides

Secrets and per-run values are **not** stored in the scenario file.

| Input | Form | Effect |
|---|---|---|
| `SCENARIO` | `-e SCENARIO=path` | which scenario file to load |
| `TEST_ID` | `-e TEST_ID=...` (run.sh generates it) | identifies the test in workspace names, results folder and logs |
| `REUSE_WS` | `-e REUSE_WS=true\|false` | overrides `workspaces.reuseWs`; any other value is an error |
| token variables | env vars named by `tokenEnv`, `adminTokenEnv`, `artifactTokenEnv` and `grafana.tokenEnv` | the secrets themselves; the file holds only the variable **names** |

The effective scenario (after defaults and overrides) is written to `scenario.effective.json` in the results folder so a result can always be traced to its configuration.

## Field reference

Notation: **req** = required. Unlisted keys are rejected, so a typo such as `concurency` is an error, not silently ignored.

### Top level

| Key | Type | Default | Meaning |
|---|---|---|---|
| `scenario` | string, `^[a-z0-9][a-z0-9-]{0,39}$` | req | scenario name |
| `version` | `1` | req | format version |
| `description` | string, up to 500 | `""` | free text |
| `tfe`, `workload`, `stages` | objects/array | req | see below |
| `workspaces`, `polling`, `limits`, `saturation`, `abort`, `grafana` | objects | defaults (`grafana`: off) | see below |

### `tfe`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `address` | URL, no path | req | TFE base URL, e.g. `https://tfe.example.internal` (a trailing `/` is removed) |
| `organization` | string | req | an **existing** organization; the test never creates or deletes it |
| `tokenEnv` | env var name | `TFE_TOKEN` | variable holding the API token |
| `adminTokenEnv` | env var name | none | optional; enables the admin queue and force-cancel calls. If the variable is unset, those features are off |

### `workload`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `artifactUrl` | http(s) link ending `.tar.gz` or `.tgz` | req | prebuilt configuration archive in Artifactory |
| `artifactSha256` | 64 hex chars | none | if set, the wrapper refuses a download with a different hash |
| `artifactTokenEnv` | env var name | none | variable holding the Artifactory token, when the link needs one |
| `terraformVersion` | `MAJOR.MINOR.PATCH` | req | exact Terraform version set on the workspace (must be available in the air-gapped TFE) |
| `runVariables` | object of string, number or boolean | `{}` | Terraform variables set on each workspace. This is how the test module's knobs are set (`mock_count`, `hold_seconds`, `payload_kb`, ...) |

### `workspaces`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `namePrefix` | `[A-Za-z0-9_-]`, 1-20 chars | `tfcap` | start of every workspace name |
| `reuseWs` | boolean | `false` | `false`: a new workspace per iteration, force-deleted afterwards. `true`: a pool of workspaces created in `setup()` (one per slot) and reused; each run gets a fresh `nonce` variable so it still changes something |
| `autoApply` | `true` | `true` | version 1 supports only auto-apply (a run waiting for confirmation would never finish) |
| `executionMode` | `"remote"` | `"remote"` | version 1 supports only remote execution, since agent pods are what is being measured |
| `deleteAfterRun` | boolean | `true` | delete the workspace after its run finishes |
| `keepOnFailure` | boolean | `false` | keep failed workspaces for inspection; `cleanup.js` removes them later |

Workspace names are `<namePrefix>-<testid>-v<vu>-i<iteration>`, for example `tfcap-20261118101500a1b2-v3-i7`. Every workspace of a test shares the prefix `<namePrefix>-<testid>-`, which is how `cleanup.js` finds leftovers. The maximum name length in TFE is not documented in the pages consulted **[V]**; the format keeps names around 50 characters.

### `polling`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `intervalSec` | number 1-60 | `4` | time between status reads of one run |
| `jitter` | number 0-1 | `0.25` | random spread of the interval (0.25 = plus or minus 25%), so VUs do not poll in lockstep |

Keep the request rate well under the documented API limit of 30 requests per second per user or IP: roughly `concurrency / intervalSec` polling requests per second plus creation calls.

### `limits`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `maxRunWaitSec` | integer 60-86400 | `1800` | a run still in flight after this is recorded as `timed_out`, its workspace is force-deleted (after an optional cancel), and the iteration ends. Also sets k6's `gracefulStop` to this value plus 120s |
| `cancelBeforeDelete` | boolean | `true` | try a best-effort cancel before the force delete |

### `stages`

An ordered array of 1-30 stages. Each is a time window; each VU is one slot and one iteration is one full run lifecycle.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | `^[a-z0-9][a-z0-9_-]{0,19}$` | req | unique; used as the `stage` tag on metrics |
| `role` | `baseline`, `ladder`, `return` | `ladder` | how the analysis treats the stage |
| `concurrency` | integer 1-500 | req | number of VUs at this stage |
| `rampSec` | integer >= 0 | `60` | time to move to this concurrency |
| `warmupSec` | integer >= 0 | `120` | held at the target but excluded from measurement |
| `holdSec` | integer >= 1 | req | the measured window |

Per stage, `phase` is `ramp` (first `rampSec`), then `warmup` (`warmupSec`), then `measure` (`holdSec`). Only runs **created** in the measure phase count toward that stage's results. Runs still in flight at the next stage boundary stay attributed to the stage they started in.

### `saturation`

Thresholds for the knee analysis in `handleSummary`. The signal definitions are in the design document, section 5.

| Key | Type | Default | Signal |
|---|---|---|---|
| `queueWaitP50Sec` | number > 0 | `30` | S1: median queue wait above this |
| `runDurationP95VsBaseline` | number > 1 | `1.5` | S2: p95 run duration above this multiple of baseline |
| `throughputEfficiencyMin` | number in (0, 1] | `0.80` | S3: throughput per slot below this fraction of baseline |
| `failureRateMax` | number 0-1 | `0.01` | S4: failure rate above this |
| `minRunsPerStage` | integer >= 1 | `20` | a stage with fewer measured runs is marked invalid |
| `baselineSummary` | path | none | `summary.json` of an earlier run, used as the baseline when the scenario has no `baseline` stage (typically a `return` scenario) |

### `abort`

Stops the test early through k6 thresholds with `abortOnFail`. This is a safety stop, separate from the knee analysis.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `failureRate` | number in (0, 1] | `0.2` | abort when the overall run failure rate exceeds this (evaluated after a 60s delay) |
| `any429` | boolean | `true` | abort on the first HTTP 429 from TFE, because the test is then measuring the rate limiter |

### `grafana` (optional)

Absent means no Grafana features. When present, it is used only **after** the test, by `postprocess.js`, to copy metrics into the results folder and to post annotations. It can never change the test outcome. See `docs/test-results-and-retention.md`, section 1 (how to create the token and read a metric).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `address` | URL, no path | req | Grafana base URL |
| `tokenEnv` | env var name | `GRAFANA_TOKEN` | service account token variable; if unset at run time, Grafana steps are skipped with a warning |
| `datasourceUid` | string | req unless `collectInfra` is false | the Prometheus data source queried through Grafana |
| `annotate` | boolean | `true` | post one annotation per stage and a knee marker (tag `tfcap`; show them with a dashboard annotation query on that tag) |
| `collectInfra` | boolean | `true` | run the queries in `queriesFile` for each stage window |
| `queriesFile` | path | `config/infra-queries.json` | queries to run, each returning one series; format in `config/infra-queries.example.json` |

Grafana and Prometheus keep 12 hours of metrics here, and the queries run after the test, so the validator warns when the scenario plus drain time leaves less than an hour of margin. Retention of the result folders is manual (results document, section 6).

## Validation rules

Checked per field (types, ranges, patterns above) and across fields:

1. Stage names are unique.
2. At most one `baseline` stage, and it must be first.
3. `concurrency` never decreases from one stage to the next (k6 would have to ramp down, which overlaps the next measured window).
4. `ladder` stages have strictly increasing concurrency.
5. A `return` stage cannot be in the same file as `ladder` stages; it runs in its own invocation.
6. All problems are reported together, each with a path such as `$.stages[2].holdSec`.

Warnings (the scenario still runs):

- No `baseline` stage and no `saturation.baselineSummary`: signals S2 and S3 cannot be evaluated.
- A stage's `holdSec` is shorter than `limits.maxRunWaitSec`: slow runs may not finish inside the window.
- Scenario plus drain time leaves less than an hour inside the 12-hour metrics retention (only when `grafana.collectInfra` is on).

Sizing note: a closed-loop slot completes about one run per run-duration, so the baseline stage (N=1) needs `holdSec` of at least `minRunsPerStage` times the run duration (20 runs of about 60 s is 1200 s). The ladder example uses 1800 s.

## What the file turns into in k6

| Scenario | k6 |
|---|---|
| `stages` | one `ramping-vus` scenario: per stage a ramp to `concurrency` over `rampSec`, then a hold of `warmupSec + holdSec` |
| `limits.maxRunWaitSec` | `gracefulStop` = value + 120s; `gracefulRampDown` is `0s` |
| `abort` | thresholds with `abortOnFail` on `tfe_test_run_failed` and `tfe_test_api_429` |
| per stage | placeholder thresholds on tagged metrics so the per-stage sub-metrics appear in the summary **[V]** |
| `reuseWs: true` | `setupTimeout` and `teardownTimeout` scaled to the pool size |
| everything else | read by `main.js` and `lib/tfe.js` at runtime |

Print the exact options with `node tools/validate-scenario.mjs <file> --print-options`.

## What is deliberately not configurable

- Secrets (only variable names are stored).
- Auto-apply off and non-remote execution (version 1).
- VCS-driven runs (out of scope).
- Per-stage workloads: one scenario uses one archive. To compare workloads, run two scenarios with the same stages.

## Changing the format

`version` is `1`. A change that alters the meaning of an existing key, or removes one, needs `version: 2` and a validator that rejects the old version with a clear message. New optional keys with defaults may be added to version 1; update `schema/scenario.schema.json`, `lib/config.js`, this document and `test/config.test.mjs` together.

## Not verified

- The two-tag threshold syntax (`metric{stage:x,phase:measure}`) and `abortOnFail` with `delayAbortEval` should be confirmed on the k6 version in use. No k6 binary was available when this was written; the validator and derivation were tested in Node only.
- The maximum workspace name length in TFE.
- Whether your TFE 2.0.x accepts every Terraform version you set; versions must be present in the air-gapped installation.
