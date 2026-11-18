# TFE Capacity / Saturation Test Harness (k6)

Drives Terraform Enterprise through real run lifecycles to find its execution-concurrency
saturation point. Closed-model k6: **1 VU = 1 worker = 1 in-flight run**, each run in its
own ephemeral workspace that is deleted afterwards. Runs entirely from outside the cluster
against the TFE HTTPS API. See the project design doc (`claude/tfe-capacity-test-design.md`)
for the full rationale.

## Layout
```
run_test.sh                 bash orchestrator (resolve -> fetch -> stages -> merge -> cleanup)
resolve.js                  scenario JSON -> sourceable env (no jq)
stage.js                    one concurrency stage: driver + observer scenarios
merge.js                    fold per-stage summaries -> summary.json + knee analysis
cleanup.js                  standalone teardown / crash recovery by name prefix
lib/tfe.js                  TFE JSON:API client (reconcile with your existing JS client)
lib/metrics.js              k6 custom metrics (Counter/Trend only)
lib/util.js                 durations, name templating, run-state groups, timestamp math
config/scenario.example.json  test data (JSON)
workload/state-heavy/       synthetic Terraform (null/random/time/local) -> package as .tar.gz
```

## Prerequisites
- `k6`, `bash`, `curl`, `openssl` on the jump host / workstation.
- Network egress to the TFE API and to Artifactory only (no Prometheus/Grafana/K8s exposure needed).
- A TFE API token. An **admin** token additionally enables the observer (cluster-wide queue depth).

## Run
```bash
export TFE_TOKEN=xxxxx            # required
export ARTIFACTORY_TOKEN=yyyyy    # optional (Artifactory auth)
./run_test.sh config/scenario.example.json
# artifacts: results/<test_id>/summary.json, summary-stage-<C>.json, test.log, cleanup.json
```

## Configure (`config/scenario.example.json`)
- `tfe.address`, `tfe.organization`, `tfe.tls_skip_verify`.
- `workload.tarball_url` — Artifactory link to the config slug; `auto_apply`.
- `workspace.name_template` — must include `{test_id}` so cleanup can find orphans.
- `stages.concurrency` — the ramp; include the config ceiling (`TFE_CAPACITY_CONCURRENCY × replicas`).
- `stages.dwell`, `stages.graceful_stop` (≥ one full run lifecycle), `stages.warmup_stage`.
- `polling.expected_run_duration` + `run_deadline_factor` — per-run watchdog.
- `observed_config` — recorded verbatim; drives the below/at-ceiling regime labels and knee note.
- `saturation.*` — knee thresholds used by `merge.js`.

## Workload
`workload/state-heavy/` uses only `null`/`random`/`time`/`local` — **no real infrastructure**.
Tune load shape with `resource_count` / `file_count` / `file_bytes` / `sleep_seconds` (hold them
fixed across stages). Build each profile as its own tarball and publish to Artifactory:
```bash
tar -czf state-heavy-v1.tar.gz -C workload/state-heavy .
# then PUT it to Artifactory and point workload.tarball_url at it
```
Suggested profiles: `orchestration-light`, `state-heavy`, `cpu-heavy` (the last needs
`enable_local_exec=true` and local-exec permitted in your run environment).

## Reconcile with your existing JS tfe-client
`lib/tfe.js` is a drop-in reference for the method surface the harness needs:
`createWorkspace`, `deleteWorkspace`, `listWorkspacesByPrefix`, `createConfigurationVersion`,
`uploadConfiguration`, `createRun`, `readRun`, `applyRun`, `cancelRun`,
`listWorkspaceRunsByStatus`, `adminCountRunsByStatus`. If your client already provides these,
import it instead and keep the backoff + `status-timestamps` handling.

## Confirm before a real run
- **status-timestamps keys** in `lib/util.js` (`planning-at` / `applying-at` are the uncertain
  ones) against a real run payload from your TFE version; mismatches degrade to `null`, not wrong numbers.
- The `null`/`random`/`time`/`local` providers and the pinned Terraform version exist in the
  **air-gapped provider mirror**.
- Whether `local-exec` provisioners are permitted (needed for the cpu-heavy profile).
- Admin token availability (observer); otherwise queue depth is skipped and logged.

## Notes
- **Rate limits:** runs are polled by ID (30/s bucket); the observer uses the Admin Runs list at
  ≤12/min (under the 30/min list cap).
- **Per-stage percentiles** come from each stage's own `k6 run` (`handleSummary`), so no
  time-series DB is required.
- **Cleanup** runs on every exit (success, failure, Ctrl-C) via a bash trap, and can be run
  standalone: `k6 run cleanup.js -e TEST_ID=<id> -e TEST_DATA=config/scenario.example.json`.
