# Test configuration format — design (version 1)

This document describes the **design of the scenario configuration format** for the k6 TFE
capacity-test harness: the k6 concepts the format is built on, the goals that shaped it, how each
part of the file maps onto k6's execution model, and the field-level specification. It is a design
document rather than a tutorial — for running a test see the README and the harness design doc
(`tfe-capacity-test-design.md`).

A **scenario file** is a JSON document that fully describes one capacity-test run: which TFE and
organization to hit, which prebuilt configuration archive to run, how workspaces are handled, and the
concurrency ladder with its saturation and abort rules. To run a different test you write a different
scenario file; you do not edit `stage.js`, `merge.js` or `lib/*.js`.

Supporting artifacts: the machine-readable schema `config/scenario.schema.json` (JSON Schema
2020-12), the validators `validate.js` / `lib/validate-core.js` / `tools/validate-scenario.mjs`, and
the examples under `config/`.

---

## 1. The k6 concepts the format is built on

The scenario file is ultimately a declarative description of **k6 scenarios**. Its design only makes
sense against k6's execution model, so that model comes first.

### 1.1 Scenarios, executors, VUs, iterations
k6 runs load as one or more **scenarios**. Each scenario has an **executor** that decides how work is
scheduled. A **VU** (virtual user) is a parallel worker that repeatedly runs an `exec` function; one
pass through that function is an **iteration**. In this harness **one iteration is one full TFE run
lifecycle** — create workspace → upload config version → create run → poll → apply → delete workspace
— so **1 VU = 1 worker = 1 in-flight run**.

### 1.2 The execution lifecycle
A k6 test runs in phases
([test lifecycle](https://grafana.com/docs/k6/latest/using-k6/test-lifecycle/)):

1. **init** — module top level. This is where `open()` reads the scenario file. No network calls are
   allowed here, which is why the workload tarball is downloaded by the wrapper beforehand and only
   `open()`-ed in init.
2. **`setup()`** — runs once before the VUs.
3. **VU iterations** — the scenario's executor schedules these.
4. **`teardown()`** — runs once after the VUs (best-effort; not guaranteed on SIGINT).
5. **`handleSummary()`** — produces the result files. It runs **even if the test is aborted**, which
   is why a per-stage summary still lands when an early stop or a threshold abort fires.

### 1.3 Open vs closed model — the decision that shapes everything
Executors fall into two families
([open vs closed](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/)):

- **Closed model** (VU executors — `constant-vus`, `ramping-vus`): a VU starts its next iteration
  **only when the previous one finishes**, so in-flight iterations are capped by the VU count.
- **Open model** (arrival-rate executors — `constant-arrival-rate`, `ramping-arrival-rate`):
  iterations start at a **configured rate regardless of completion**, and k6 adds VUs to sustain that
  rate.

The quantity this test controls is **execution concurrency** — how many TFE runs execute at once.
That is a closed-model quantity: set `vus = concurrency` and exactly N run lifecycles are in flight.
An open model would keep launching runs no matter how slowly TFE drains them, piling into TFE's own
queue and measuring arrival pressure instead of execution capacity. **The format therefore only ever
produces closed-model VU executors; arrival-rate executors are never generated.** This single
decision is why the central field is a list of concurrencies, not a request rate.

### 1.4 Executors, and the one the format uses
| Executor | Model | Used? | Why / why not |
|---|---|---|---|
| `constant-vus` | closed | **yes** | holds a fixed VU count for a duration = steady-state concurrency hold |
| `ramping-vus` | closed | no | valid alternative (one run, many stages) but needs tagged-sub-metric threshold tricks to split results per stage |
| `constant-arrival-rate` | open | no | targets a request rate, not concurrency (§1.3) |
| `ramping-arrival-rate` | open | no | same |
| `per-vu-iterations` / `shared-iterations` | closed | no | bounded by iteration **count**, not duration |
| `externally-controlled` | closed | no | needs a live operator; no `gracefulStop` |

### 1.5 Graceful stop
When a scenario's `duration` ends, k6 waits up to **`gracefulStop`** (default **30s**) for in-flight
iterations to finish before interrupting them; interrupted iterations skew metrics
([graceful stop](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/graceful-stop/)).
Because an iteration here is a multi-minute lifecycle that ends by **deleting a workspace**, the
default 30s is far too short — it would orphan workspaces and truncate duration samples at every
stage boundary. The format exposes this as `stages.graceful_stop`, which the design requires to be
≥ one full run lifecycle. (`ramping-vus` also has `gracefulRampDown` for VUs removed on a downward
ramp; irrelevant here because each stage is its own run.)

---

## 2. Design goals

The format is shaped by these goals, in priority order:

1. **A test is defined without code changes.** Everything that varies between tests lives in the
   scenario file; the scripts are fixed. Writing or changing a test means editing JSON only.
2. **Scenarios are fully declarative.** Every input a test needs — target, workload, ladder,
   thresholds, naming, even the Terraform variable knobs and the env-var *names* for secrets — is a
   field. Nothing essential is left to code or to undocumented flags.
3. **Secrets never live in the file.** The file names the environment variables that hold tokens; the
   values stay in the environment (§7).
4. **A closed vocabulary.** Unknown keys are rejected, so `concurency` is an error, not a silently
   ignored typo.
5. **Validated and fail-fast, checkable offline.** A scenario is validated before anything touches
   TFE, by the same logic in two places (§6).
6. **Versioned.** The format carries a `version` so it can evolve without silently misreading old
   files (§9).
7. **JSON, not YAML.** k6 parses JSON natively via `open()` and has no built-in YAML, so the harness
   reads a scenario with zero extra dependencies. (No comments in JSON — use the label fields.)

---

## 3. How the format maps onto k6

The design is a thin, declarative projection of §1:

| Scenario field | k6 realization |
|---|---|
| `stages.concurrency[i]` | its **own `k6 run`** with a `constant-vus` scenario, `vus` = that value |
| `stages.dwell` | that scenario's `duration` (the measured steady-state window) |
| `stages.graceful_stop` | `gracefulStop` on the driver and observer scenarios |
| (observer) | a second `constant-vus: 1` scenario in the same run, sampling queue depth |
| `stages.return_to_baseline` | an extra `constant-vus` run labeled `baseline-return` (drift check) |
| `polling.run_interval` | the VU's in-iteration poll loop (`sleep` between `GET /runs/:id`) |
| `workload.run_variables` | per-run Terraform `variables` on `createRun` |
| `abort.*` | thresholds with `abortOnFail` |
| `saturation.stop_on_knee` | after each stage, `evaluate.js` checks the knee; the wrapper halts once it is confirmed |

**Why one `constant-vus` run per stage** (the central design choice): each ladder entry is an
isolated `k6 run`. Because the run contains exactly one concurrency level, that level's percentiles
come straight from the run's own `handleSummary` — no time-series database, and none of the
tagged-sub-metric threshold tricks a single multi-stage `ramping-vus` run would require. It also lets
the bash wrapper evaluate each stage and stop the ladder early (`stop_on_knee`), which a single
continuous run cannot do. The cost is repeated setup per stage, which is negligible at this scale.

---

## 4. Structure of the scenario file

Top level: a `version`, three required descriptive objects (`test`, `tfe`, `workload`), the required
`stages` and `observed_config`, and optional tuning objects (`artifactory`, `workspace`, `polling`,
`abort`, `saturation`) that all default. The design intent of each section:

- **`test`** — identity/labels only.
- **`tfe`** — where to run and *which env vars* hold the tokens; no secrets.
- **`workload`** — points at a prebuilt archive by URL (optionally pinned by sha256) and, via
  `run_variables`, tunes the module's knobs without rebuilding the archive.
- **`workspace`** — the ephemeral-workspace policy and the naming template (which must carry
  `{test_id}` so cleanup and the startup guard can find a test's workspaces).
- **`stages`** — the controlled variable: the concurrency ladder plus its timing (`dwell`,
  `graceful_stop`, warmup, return-to-baseline).
- **`polling`** — client-side cadence and the per-run watchdog.
- **`abort`** — safety stops (k6 `abortOnFail`), separate from the knee analysis.
- **`saturation`** — the knee thresholds and the early-stop switch.
- **`observed_config`** — records the TFE capacity setting and replica count so results can be read
  against the config ceiling; free-form, so other environment facts can be recorded alongside.
- **`grafana`** (optional) — connection + toggles for the report step's annotations and infra pull;
  the queries themselves live in `infra-queries.json`. Retention is not a scenario field (it is
  manual for now; see `tfe-test-results-and-retention.md`).

---

## 5. Field reference (specification)

Notation: **req** = required. Unlisted keys are **rejected**. Durations are k6-style strings — digits
+ optional `s`/`m`/`h` (bare = seconds): `30`, `90s`, `15m`, `1h`.

### Top level
| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | req | format version |
| `test` | object | req | identity |
| `tfe`, `workload`, `stages`, `observed_config` | object | req | see below |
| `artifactory`, `workspace`, `polling`, `abort`, `saturation` | object | all defaults | see below |

### `test` (req)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | req | scenario name, recorded in results |
| `id_prefix` | string | `k6cap` | informational label for the test family |

### `tfe` (req)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `address` | https URL | req | TFE base URL, e.g. `https://tfe.example.internal` (trailing `/` removed) |
| `organization` | string | req | an **existing** org; the test never creates or deletes it |
| `tls_skip_verify` | boolean | `false` | last resort only — prefer `SSL_CERT_FILE` |
| `token_env` | env var name | `TFE_TOKEN` | variable holding the API token (must be able to **force-delete** workspaces) |
| `admin_token_env` | env var name | none | optional; enables the observer's cluster-wide queue-depth sampling. If unset, that feature is off |

### `artifactory` (optional)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `base_url` | URL | none | informational |
| `token_env` | env var name | `ARTIFACTORY_TOKEN` | variable holding the Artifactory token for the tarball download |

### `workload` (req)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `config` | string | none | workload profile label (e.g. `state-heavy`, `noprov-light`) |
| `tarball_url` | http(s) link to `.tar.gz` | req | prebuilt configuration archive in Artifactory |
| `tarball_sha256` | 64 hex chars (or `""`) | none | if set, the wrapper refuses a download with a different hash |
| `terraform_version` | string | none | Terraform version pinned on the workspace (must exist in the air-gapped TFE) |
| `auto_apply` | boolean | `true` | exercise apply automatically after a successful plan |
| `run_variables` | object of string/number/boolean | `{}` | Terraform variables set per run — tunes the module's knobs (`mock_count`, `hold_seconds`, `payload_kb`, …) without rebuilding the tarball. Captured in `summary.json` |

### `workspace` (optional)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `name_template` | string containing `{test_id}` | `k6cap-{test_id}-vu{vu}-{seq}` | workspace name pattern. **Must contain `{test_id}`**; `{vu}`/`{seq}` make each ephemeral workspace unique. Final name may use only letters, numbers, `-`, `_` |
| `execution_mode` | `"remote"` | `"remote"` | version 1 supports only remote execution, since agent pods are what is measured |
| `delete_after_run` | boolean | `true` | force-delete each workspace after its run finishes |

### `stages` (req)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `concurrency` | array of 1+ unique integers ≥1 | req | the ladder: execution concurrency (= k6 VUs) per stage. Each entry is one `k6 run`. Include the config ceiling (`TFE_CAPACITY_CONCURRENCY × replicas`) |
| `return_to_baseline` | integer ≥1 | none | re-run this concurrency after the ladder (labeled `baseline-return`) to detect drift |
| `dwell` | duration | `15m` | steady-state measured window per stage |
| `warmup_stage` | boolean | `true` | treat the **first** stage as warmup, excluded from the knee calculation |
| `graceful_stop` | duration | `5m` | k6 `gracefulStop` per stage; set ≥ one full run lifecycle (§1.5) |
| `min_completions_per_stage` | integer ≥1 | `20` | a stage with fewer measured completions is flagged as not steady |

### `polling` (optional)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `run_interval` | duration | `5s` | time between status reads of one run (polled by ID, fast bucket) |
| `observer_interval` | duration | `5s` | how often the observer samples cluster-wide queue depth |
| `run_deadline_factor` | number >0 | `3` | watchdog: a run is force-timed-out after `factor × expected_run_duration` |
| `expected_run_duration` | duration | `5m` | expected single-run time; calibrate in an N=1 pilot |

### `abort` (optional)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `failure_rate` | number 0–1 | `0.2` | abort the stage when the run failure rate exceeds this (after a 1-minute delay) |
| `any_429` | boolean | `true` | abort on any HTTP 429 (the test is then measuring the rate limiter) |

### `saturation` (optional)
| Key | Type | Default | Signal |
|---|---|---|---|
| `throughput_gain_floor_pct` | number | `10` | knee if added concurrency yields `<` this % more completion throughput |
| `p95_run_duration_rise_pct` | number | `50` | knee if p95 run duration rises `>` this % over baseline |
| `queue_never_drains` | boolean | `true` | treat a never-draining queue (below ceiling) as saturation |
| `failure_rate_pct` | number | `2` | knee if the per-stage failure rate exceeds this % |
| `stop_on_knee` | boolean | `false` | halt the ladder once the knee is confirmed (one stage past it) |

### `observed_config` (req)
| Key | Type | Default | Meaning |
|---|---|---|---|
| `tfe_capacity_concurrency` | integer ≥1 | req | `TFE_CAPACITY_CONCURRENCY` in effect (per pod) |
| `terraform_enterprise_replicas` | integer ≥1 | req | number of `terraform-enterprise` pods. ceiling = concurrency × replicas |

Additional keys are allowed in `observed_config` (free-form); it is copied verbatim into results and
drives the below/at-ceiling stage labels.

### `grafana` (optional)
Connection and toggles for the re-runnable report step, which writes stage-window annotations and
pulls per-window infra metrics (see `tfe-test-results-and-retention.md`). Outbound calls to the
Grafana API only; the token comes from `token_env`. The PromQL itself is **not** here — it lives in
the operator-owned `infra-queries.json`, referenced by `queries_file`, because metric names are
cluster-specific, not test-specific.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | turn the Grafana integration on |
| `base_url` | https URL | req if enabled | Grafana base URL |
| `token_env` | env var name | `GRAFANA_TOKEN` | variable holding the Grafana API token |
| `datasource_uid` | string | req if enabled | datasource queried for infra metrics |
| `queries_file` | path | `config/infra-queries.json` | operator-owned PromQL query file |
| `step_sec` | integer ≥1 | `15` | range-query step in seconds |
| `annotate` | boolean | `true` | post stage-window annotations after the ladder (never live) |
| `annotation_tags` | string[] | `["tfcap"]` | base tags; `test_id`, `stage`, `knee` are added automatically |
| `org_id` | integer ≥1 | none | Grafana org, if not default |
| `dashboards` | string[] | none | dashboard links recorded in `summary.json` |

> **Retention is not a scenario field and is manual for now.** Each run writes a dated folder under
> `results/`, deleted by hand; see `tfe-test-results-and-retention.md` §Retention.

---

## 6. Validation design

Validation is one body of rules (`lib/validate-core.js`, a pure function) used in two places so they
can never drift: `validate.js` runs it in k6 at startup (the wrapper aborts on failure), and
`tools/validate-scenario.mjs` runs the same function in Node for an offline check that needs neither
k6 nor TFE. Both report **all** problems at once, each with a path such as `stages.concurrency[2]`.

Cross-field rules of note: `version` must be `1`; `workspace.name_template` must contain `{test_id}`;
`stages.concurrency` entries must be unique (per-stage summary files are keyed by concurrency);
`execution_mode` must be `remote`. Warnings (still runs): `admin_token_env` unset (observer skipped),
top stage above the config ceiling (raise `TFE_CAPACITY_CONCURRENCY` for the ladder), and a
non-ascending ladder.

---

## 7. Per-invocation inputs (secrets and overrides)

Secrets and run-specific values are intentionally **not** in the scenario file:

| Input | Form | Effect |
|---|---|---|
| scenario path | `./run_test.sh <path>` (→ `-e TEST_DATA=<path>`) | which scenario to load |
| `TEST_ID` | generated by the wrapper | identifies the test in names, results folder, logs |
| token variables | env vars **named by** `token_env` / `admin_token_env` (artifactory) | the secrets themselves |
| `SSL_CERT_FILE` | env var | private CA bundle (preferred over `tls_skip_verify`) |
| `ALLOW_FOREIGN=1` | env var | override the startup guard |

The resolved scenario is echoed to `results/<test-id>/resolved.env`, and `meta.json` records the
artifact URL + sha256, so any result traces back to its exact configuration.

---

## 8. What is deliberately not configurable

These are design decisions, not omissions:

- **Secrets** — only variable names are stored.
- **Auto-apply off / non-remote execution** — excluded in version 1 (a run awaiting confirmation
  never finishes; agent pods are what we measure).
- **VCS-driven runs** — out of scope; the test is API-driven only.
- **Per-stage workloads** — one scenario uses one archive. To compare workloads, run two scenarios
  with the same stages and compare their `summary.json`.
- **Open-model / arrival-rate execution** — excluded by §1.3.

---

## 9. Versioning / changing the format

`version` is `1`. A change that alters the meaning of an existing key, or removes one, requires
`version: 2` and a validator that rejects version 1 with a clear message. New **optional** keys with
defaults may be added within version 1 — update `config/scenario.schema.json`,
`lib/validate-core.js`, this document, and the examples together.

---

## 10. Not verified ([V])

- Maximum workspace name length in TFE.
- Exact `status-timestamps` key names and the `has-changes` attribute (freeze from a real run payload in the pilot).
- Whether your TFE 2.0.x accepts every Terraform version set; versions must be present in the air-gapped installation.
- `abortOnFail` with `delayAbortEval` behavior on the exact k6 version in use (validator and derivations were tested in Node; confirm against the k6 binary).
