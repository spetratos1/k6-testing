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
- `k6`, `bash`, `curl`, `openssl`, `sha256sum` on the jump host / workstation.
- Network egress to the TFE API and to Artifactory only (no Prometheus/Grafana/K8s exposure needed).
- A TFE API token that can **force-delete** workspaces (org owner, or workspace-admin if the org
  allows it). An **admin** token additionally enables the observer (cluster-wide queue depth).
- For a private CA, export `SSL_CERT_FILE=/path/to/ca.pem` — do **not** use `insecureSkipTLSVerify`.

## Run
```bash
export TFE_TOKEN=xxxxx            # required (force-delete capable)
export ARTIFACTORY_TOKEN=yyyyy    # optional (Artifactory auth)
export SSL_CERT_FILE=/etc/ssl/tfe-ca.pem   # private CA, recommended
./run_test.sh config/scenario.example.json
# artifacts: results/<test_id>/summary.json, summary-stage-*.json, test.log, meta.json,
#            guard.json, cleanup.json
```
The wrapper runs a **startup guard** first (aborts if leftover `tfcap-*` workspaces from another
test exist; `ALLOW_FOREIGN=1` to override), then the ladder, then a **return-to-baseline** stage
for drift detection, then merge + cleanup.

## Raise the capacity setting for the ladder
Concurrency is capped at `TFE_CAPACITY_CONCURRENCY × replicas`. For the **saturation** ladder,
raise it so the ceiling is ≥ your top stage — otherwise queueing above the ceiling is forced by
configuration and tells you nothing about CPU/memory/disk/Postgres. Run one separate confirmation
at the real production setting. Record both in `observed_config`.

## Configure (`config/scenario.example.json`)
- `tfe.address`, `tfe.organization`, `tfe.tls_skip_verify`.
- `workload.tarball_url` — Artifactory link to the config slug; `auto_apply`.
- `workspace.name_template` — must include `{test_id}` so cleanup can find orphans.
- `stages.concurrency` — the ramp; include the config ceiling (`TFE_CAPACITY_CONCURRENCY × replicas`).
- `stages.dwell`, `stages.graceful_stop` (≥ one full run lifecycle), `stages.warmup_stage`.
- `polling.expected_run_duration` + `run_deadline_factor` — per-run watchdog.
- `observed_config` — recorded verbatim; drives the below/at-ceiling regime labels and knee note.
- `saturation.*` — knee thresholds used by `merge.js`.

## Workload (deterministic, no real infrastructure)
Modules use **`terraform_data`** (built-in, no provider download) plus `local`/`time` only. Nothing
is random or time-based except one constant `hold_seconds`, so variance comes from TFE, not the
workload. In reuse mode a `nonce` run-variable forces changes instead of `timestamp()`.
- `workload/noprov-light/` — **no providers at all** (terraform_data only). Run it through the same
  short ladder: if it scales but a provider-using profile doesn't, the **provider mirror** is the
  first bottleneck, not TFE.
- `workload/state-heavy/` — `mock_count` × `payload_kb` local files → state + object-storage load.

Build each profile as its own tarball and publish to Artifactory (the wrapper records its sha256):
```bash
tar -czf state-heavy-v1.tar.gz -C workload/state-heavy .
# PUT it to Artifactory; point workload.tarball_url at it
```

## Reconcile with your existing JS tfe-client
`lib/tfe.js` is a drop-in reference for the method surface the harness needs:
`createWorkspace`, `deleteWorkspace`, `listWorkspacesByPrefix`, `createConfigurationVersion`,
`uploadConfiguration`, `createRun`, `readRun`, `applyRun`, `cancelRun`,
`listWorkspaceRunsByStatus`, `adminCountRunsByStatus`. If your client already provides these,
import it instead and keep the backoff + `status-timestamps` handling.

## Confirm before a real run
- **status-timestamps keys** in `lib/util.js` (`planning-at` / `applying-at` are the uncertain
  ones) against a real run payload; mismatches degrade to `null`, not wrong numbers. Also confirm
  the `has-changes` attribute name.
- The `local`/`time` providers (pinned versions) and the Terraform version exist in the
  **air-gapped provider mirror** (`noprov-light` needs none).
- The TFE token can force-delete workspaces; admin token availability (observer).
- Calibrate `expected_run_duration` / `dwell` / `maxRunWait` in an N=1,2 pilot first.

## Notes
- **Rate limit:** 30 req/s per user/IP (configurable, min 30). Runs are polled by ID; any 429 is
  treated as stage-invalidating (`tfe_test_api_429` → abort threshold).
- **Percentiles:** p50/p90/p95/max only (p99 omitted — too few runs per stage to be meaningful).
- **Per-stage percentiles** come from each stage's own `k6 run` (`handleSummary`), so no TSDB.
- **Abort thresholds:** failure rate and any-429 hard-stop a stage via k6 `abortOnFail`.
- **Cleanup** runs on every exit via a bash trap, and standalone:
  `k6 run cleanup.js -e TEST_ID=<id> -e TEST_DATA=config/scenario.example.json`.

## Also measure (operator, from existing monitoring — not the harness)
- **Data accumulation:** workspace deletion may not remove runs/logs/state; Postgres doesn't return
  disk after row deletes. Record Postgres + object-storage size before/after the pilot and a day
  later, extrapolate per-run growth, and prefer a non-production mirror.
- **Provider mirror / Artifactory** request rate + errors during runs (see `noprov-light`).
- **Force-delete with a run in flight:** confirm the agent pod/capacity slot is released (check for
  orphaned agent pods after the first pilot timeout), or it skews later stages.
