# Test results and retention strategy

Status: design, version 2. Replaces sections 10 and 11 of `tfe-capacity-test-design.md`. Tags:
**[F]** documented fact, **[R]** recommendation, **[V]** confirm in the pilot.

**In short:** every run produces one dated folder with three files — `summary.json` (the result),
`runs.csv` (one row per run), and `test.log` (the raw per-run log, including failure detail). Grafana
is called only after the load stops, to copy infrastructure numbers into `summary.json` and to mark
the stages on dashboards. Retention is manual.

This version converges with a parallel proposal from the team: it adopts that proposal's auditable
`summary.json` (per-stage S1–S4 criteria, a reasoned `analysis` block, an embedded effective config)
and its concrete Grafana recipe, and keeps two things from the earlier draft that the parallel one
lacked — failure detail captured *before* the workspace is deleted, and exact stage windows that come
from the per-stage run model rather than a setup-marker offset.

Prometheus here keeps 12 hours of data and no test runs that long, so the infra numbers are pulled
once at the end of the run, always inside the window.

## 1. Reading a metric and marking a stage through the Grafana API

This is what the report step does after a run, and what you can do by hand to try it first.

**Token (once, by a Grafana admin).** [F] Grafana UI → Administration → Users and access → Service
accounts → Add service account (e.g. `tfcap-test`, pick a role) → Add service account token → set an
expiry → Generate, and copy it immediately. Querying a data source needs a role that can query it;
creating annotations needs an editor-level role or a custom role with the annotation permission [V].
The scenario stores only the env-var *name* (`grafana.token_env`, default `GRAFANA_TOKEN`); the token
lives in the environment and every call sends `Authorization: Bearer <token>` [F].

**Find the query behind a panel.** Open the dashboard panel → Inspect → Query (or Panel JSON) and copy
the data-source `uid` and the expression. Three fixes before the expression works against the API [R]:
replace dashboard variables (`$namespace`, `$pod`) with real values or `.*`; replace macros
(`$__rate_interval`) with a fixed value like `2m`; and make it return **one series** by wrapping it in
`max(...)` or `sum(...)` (if it still returns several, the harness takes the max at each timestamp).
Record each `{id, resource, expr, breach_above}` in `config/infra-queries.json`.

**Query the metric** — `POST /api/ds/query` with the data-source uid; `from`/`to` are epoch ms. [F]
endpoint and body shape; [V] the Prometheus fields (`expr`, `range`) on your Grafana version.

```bash
FROM=$(date -d '30 minutes ago' +%s%3N); TO=$(date +%s%3N)
curl -sS -X POST "$GRAFANA/api/ds/query" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "from":"'$FROM'", "to":"'$TO'", "queries":[{
        "refId":"A", "datasource":{"uid":"prom-main"},
        "expr":"max(sum by (pod) (rate(container_cpu_usage_seconds_total{namespace=\"tfe\",pod=~\"terraform-enterprise-.*\"}[2m])))",
        "range":true, "intervalMs":15000, "maxDataPoints":1000 }] }'
```

The response holds `results.A.frames[0].data.values` as two arrays — timestamps and values [F]; the
report step reduces the value array to `avg`, `p95`, `max` over the stage window:

```json
{ "results": { "A": { "frames": [ { "data": { "values": [
  [1763906700000, 1763906715000, 1763906730000], [0.91, 0.94, 0.97] ] } } ] } } }
```

(The data-source proxy — `GET /api/datasources/proxy/uid/:uid/api/v1/query_range` — is a simpler way
to run one PromQL by hand and returns native Prometheus JSON; `/api/ds/query` is used by the harness
because it carries the data-source routing and can batch queries.)

**Mark a stage** — `POST /api/annotations`, a region with `time`+`timeEnd` in epoch ms and `tfcap` tags:

```bash
curl -sS -X POST "$GRAFANA/api/annotations" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "time":1763906700000, "timeEnd":1763907600000,
        "tags":["tfcap","tfcap:20261123-140500-a3f9","tfcap:stage:c25"],
        "text":"tfcap 20261123-140500-a3f9: stage c25, N=25" }'
```

An organization annotation (no `dashboardUID`) shows on any dashboard with an annotation query
filtered on the tag `tfcap`. [V] The current docs describe a newer resource-style annotations API
(`/apis/annotation.grafana.app/...`); use whichever your Grafana serves and keep the path in one place.

**Failure modes never touch the test.** If the token is missing or a query errors, the result is still
written with `infra.status` = `unavailable` or `partial`; the Grafana calls happen only after the load
has stopped.

## 2. What the result answers

`summary.json` answers five questions:

| Question | Field |
|---|---|
| Can I trust it? | `status`, `warnings`, per-stage `valid`, `infra.status`, `cleanup.result` |
| Where is the knee? | `analysis.knee_stage`, `first_breached`, `confirmed_by` |
| What concurrency is safe? | `analysis.safe_operating_concurrency`, `headroom`, `confidence` |
| When does queueing start? | per-stage `durations_sec.plan_queue`/`apply_queue`, criterion `S1` |
| What saturates first? | `infra.first_bottleneck`, `infra.per_stage` |

Rules for every number: percentiles carry `n`; a stage with fewer than `min_completions_per_stage`
measured runs is `valid:false`, not hidden; durations come from TFE `status-timestamps`, not the poll
loop; `timed_out` runs are counted but excluded from the duration percentiles; warmup is excluded from
the window; no p99 under 100 samples. `observed.executing_avg` plus `observed.waiting_avg` should track
the target (Little's law) — it is the proof the stage actually held its concurrency, and a stage where
executing sags below target with an empty queue is the jump host or API, not TFE, and is marked
invalid. `first_bottleneck` is a pointer (the first resource over its `breach_above` at or before the
knee), not proof; the evidence is `infra.per_stage`.

### Scope: one scenario per result

A result folder is one run of **one scenario** — one workload and one ladder. In the example the rows
are **stages** (concurrency steps: `baseline`, `c10` … `c30`), not scenarios; `config.scenario` names
the single scenario the folder is for. Since one scenario uses one workload archive (see the
configuration format, "what is deliberately not configurable"), a test that spans several workloads —
`state-heavy`, `plan-heavy`, `noprov-light` — or several repeats of the same ladder is **several
runs**, each with its own dated folder and `summary.json`. There is deliberately no combined
multi-scenario file: each result stays self-contained and independently trustworthy, which is what
makes manual retention and comparison viable. Compare across scenarios by reading each folder's
headline fields:

```bash
for d in results/*/; do
  jq -c '{scn:.config.scenario, knee:.analysis.knee_concurrency, safe:.analysis.safe_operating_concurrency, bn:.infra.first_bottleneck.resource}' "$d/summary.json"
done
```

Running several scenarios back-to-back (a "campaign") is a thin loop in the wrapper over a list of
scenario files; each still produces its own folder, and the result format does not change.

## 3. Files

```
results/<test-id>/            test-id = YYYYMMDD-HHMMSS-<4hex> (UTC) — folders sort and prune by date
  summary.json    the result: analysis, per-stage statistics, infra, cleanup, effective config
  runs.csv        one row per run (spreadsheets, recomputation, debugging)
  test.log        raw k6 log: one TFERUN line per finished run, TFEERR lines with failure detail
```

| File | Written by | How |
|---|---|---|
| `test.log` | the load step (k6 `--log-output=file=`) | one `TFERUN,<fields>` line per finished run; on a failure, a `TFEERR,<run_id>,<message>` line plus a short plan/apply log tail — **fetched before the workspace is deleted**, which is the only moment it exists |
| `runs.csv` | wrapper | header + `grep '^TFERUN,' test.log | cut -d, -f2-`; one derived file, no second write path |
| `summary.json` | report step | merges the per-stage summaries, the run lines, and the Grafana pull into the one result (§4) |

Per-run columns: `stage, vu, seq, workspace, run_id, outcome, created_at, pending_sec, plan_queue_sec,
plan_sec, apply_queue_sec, apply_sec, run_sec, timed_out, force_deleted, has_changes`. The error text
is not a CSV column (it is multi-line); it lives in `test.log` keyed by `run_id`.

## 4. How the result is generated

```
run_test.sh
  validate -> for each stage (and return-to-baseline):
      load step (one k6 run)  -> per-stage summary + TFERUN/TFEERR lines in test.log
      knee check              -> early-stop decision; wrapper records the stage's exact window
  cleanup (always)            -> force-delete the run's workspaces
  report step                 -> pull infra per window, post annotations, write summary.json
  runs.csv from test.log
```

**How k6 actually writes files.** k6 can write files from exactly one place: `handleSummary(data)`,
called once when a run ends — including when a threshold aborted it [F]. It returns a map of path →
content; VU code, `setup`, and `teardown` cannot write files. Two consequences shape everything. The
per-stage numbers come from `data.metrics[<name>].values` (`count`, `avg`, `min`, `med`, `max`, and
exactly the percentiles set in `summary_trend_stats`); because each stage is its own `k6 run`, that
run's `handleSummary` reads its own `data` and writes the stage summary directly — no cross-run
aggregation and no tag-splitting, which is the reason the ladder is one run per stage. And because a
VU cannot write files, each VU `console.log`s a `TFERUN` line per finished run (and a `TFEERR` line on
failure); `runs.csv` and the per-run detail are parsed from those afterward.

`handleSummary` also prints the human view to the terminal, so there is no `report.md` to keep in sync
(§5 shows it). The final `summary.json` is itself written through a `handleSummary` (the report step is
a short k6 run; equivalently a small script — same mechanism). The only output not written this way is
the optional raw sample stream, `--out json=metrics.json.gz`, added by hand for debugging k6 itself.

**Exact windows (kept from the earlier draft).** Each stage is a separate run, so the wrapper records
its real start/end wall-clock; there is no `TFESETUP_DONE` marker or offset arithmetic to reconstruct,
and the windows handed to the Grafana queries and annotations are exact.

**Grafana after the fact, inside 12 h.** During the ladder the only external calls are to TFE. The
report step touches Grafana once, at the end, from windows already on disk, so a slow or failed query
never perturbs a measurement; `--report` can re-run it against a finished folder, but only within ~12 h
while Prometheus still holds the data (the numbers already in `summary.json` stay regardless).

**Degradation.** `handleSummary` firing on abort means an aborted stage still leaves its file; the
logged `TFERUN` lines mean a mid-ladder kill still yields a `status:"incomplete"` summary (counts and
completed stages, no knee); and if the report step itself fails, the wrapper writes a minimal
`summary.json` from the per-stage files, so a result always exists.

## 5. Complete example

Synthetic numbers, internally consistent (Little's law holds within ~8% per stage; throughput,
efficiency, and the signals are computed from the counts). Not measurements of any real TFE.

Terminal view, printed by `handleSummary` at the end:

```
TFE capacity test 20261123-140500-a3f9   status: completed   scenario: tfe-capacity-ladder
stage       N  runs  runs/min   eff  queue p50   run p50   run p95   fail  signals
baseline    1    30      1.00  1.00       1.6s      56.0      59.0   0.0%  -
c10        10   144      9.60  0.96       1.9s      58.0      64.0   0.0%  -
c20        20   263     17.53  0.88       3.4s      62.0      72.0   0.0%  -
c25        25   263     17.53  0.70      14.5s      78.0      96.0   0.0%  S2,S3
c30        30   258     17.20  0.57      27.0s      96.0     128.0   1.6%  S2,S3,S4
knee: c25 (S2,S3; confirmed by c30)   safe: 20 (low confidence, 1 repeat)
first bottleneck: postgres pg_conn_ratio 0.88 > 0.85 at c25
infra: ok   cleanup: clean (1085/1085)   warnings: 2
```

`summary.json` — `baseline` and the knee stage `c25` shown in full; `c10`, `c20`, `c30` have the same
shape; `infra.per_stage` carries all five:

```jsonc
{
  "schema_version": 2,
  "test_id": "20261123-140500-a3f9",
  "status": "completed",
  "warnings": [
    "Single ladder repeat: treat the knee as a hypothesis; repeat 2-3 times at different hours.",
    "No return-to-baseline run in this invocation."
  ],
  "analysis": {                      // the verdict — derived by the report step from the stage metrics + infra, never raw data
    "baseline_stage": "baseline", "knee_stage": "c25", "knee_concurrency": 25,
    // first_breached: the first stage where a saturation signal tripped, and which ones (S1-S4)
    "first_breached": [ { "stage": "c25", "signals": ["S2", "S3"] } ],
    "confirmed_by": "c30",           // the next stage up that confirmed the knee, so it is not a one-stage blip
    "safe_operating_concurrency": 20,
    // headroom: how far the first-bottleneck resource sat below its threshold at the recommended stage (slack before it bites)
    "headroom": { "resource": "postgres", "stage": "c20", "value": 0.58, "threshold": 0.85, "headroom_pct": 31.8 },
    "confidence": "low", "repeats": 1,
    "method": "highest ladder stage below the knee where S1-S4 all pass and the first-bottleneck resource is >=25% below its threshold"
  },
  "stages": [
    { "index": 0, "name": "baseline", "role": "baseline", "target_concurrency": 1,
      "window": { "start": "2026-11-23T14:05:02Z", "measure_start": "2026-11-23T14:06:32Z", "end": "2026-11-23T14:36:32Z" },
      "valid": true, "invalid_reason": null,
      "runs": { "created": 33, "measured": 30, "applied": 30, "errored": 0, "timed_out": 0, "canceled": 0, "no_changes": 0 },
      "throughput_per_min": 1.0, "throughput_efficiency": 1.0,
      "observed": { "waiting_avg": 0.05, "executing_avg": 0.92 },
      "durations_sec": {
        "pending":     { "n": 30, "p50": 0.3, "p90": 0.4, "p95": 0.6, "max": 0.9 },
        "plan_queue":  { "n": 30, "p50": 1.6, "p90": 1.7, "p95": 1.7, "max": 1.8 },
        "plan":        { "n": 30, "p50": 13.8, "p90": 14.6, "p95": 15.2, "max": 17.9 },
        "apply_queue": { "n": 30, "p50": 1.4, "p90": 1.4, "p95": 1.5, "max": 1.6 },
        "apply":       { "n": 30, "p50": 38.5, "p90": 40.8, "p95": 42.4, "max": 50.1 },
        "run":         { "n": 30, "p50": 56, "p90": 58.0, "p95": 59.0, "max": 63.0 } },
      "workspace_ops_sec": { "create": { "p50": 1.2, "p95": 2.1, "max": 3.4 }, "delete": { "p50": 1.4, "p95": 2.6, "max": 4.8 } },
      "api": { "requests": 782, "status_429": 0, "status_5xx": 0 },
      "criteria": null },

    // c10, c20, c30: same shape

    { "index": 3, "name": "c25", "role": "ladder", "target_concurrency": 25,
      "window": { "start": "2026-11-23T15:13:02Z", "measure_start": "2026-11-23T15:17:02Z", "end": "2026-11-23T15:32:02Z" },
      "valid": true, "invalid_reason": null,
      "runs": { "created": 299, "measured": 263, "applied": 263, "errored": 0, "timed_out": 0, "canceled": 0, "no_changes": 0 },
      "throughput_per_min": 17.53, "throughput_efficiency": 0.70,
      "observed": { "waiting_avg": 5.83, "executing_avg": 17.95 },
      "durations_sec": {
        "pending":     { "n": 263, "p50": 0.5, "p90": 0.8, "p95": 1.0, "max": 1.5 },
        "plan_queue":  { "n": 263, "p50": 14.5, "p90": 16.7, "p95": 17.8, "max": 21.9 },
        "plan":        { "n": 263, "p50": 17.0, "p90": 18.0, "p95": 18.7, "max": 22.1 },
        "apply_queue": { "n": 263, "p50": 4.5, "p90": 5.2, "p95": 5.5, "max": 6.8 },
        "apply":       { "n": 263, "p50": 41.5, "p90": 44.0, "p95": 45.7, "max": 54.0 },
        "run":         { "n": 263, "p50": 78, "p90": 90.0, "p95": 96.0, "max": 118.0 } },
      "workspace_ops_sec": { "create": { "p50": 1.2, "p95": 2.1, "max": 3.4 }, "delete": { "p50": 1.4, "p95": 2.6, "max": 4.8 } },
      "api": { "requests": 8813, "status_429": 0, "status_5xx": 1 },
      "criteria": {
        "S1": { "name": "median plan queue wait (s)", "value": 14.5, "threshold": 30,  "breached": false },
        "S2": { "name": "p95 run duration vs baseline", "value": 1.63, "threshold": 1.5, "breached": true },
        "S3": { "name": "throughput efficiency",       "value": 0.70, "threshold": 0.8, "breached": true },
        "S4": { "name": "failure rate",                "value": 0.0,  "threshold": 0.01, "breached": false } } }
  ],
  "infra": {                         // resource usage per stage, pulled from Grafana after the run; the durable copy of the 12h-only Prometheus data
    "status": "ok",
    "source": { "grafana": "https://grafana.example.internal", "datasource_uid": "prom-main", "queries_sha256": "e3b0c4…" },
    "queries": [
      { "id": "tfe_pod_cpu",  "resource": "cpu",      "unit": "cores", "breach_above": 6.0 },
      { "id": "pg_conn_ratio","resource": "postgres", "unit": "ratio", "breach_above": 0.85 },
      { "id": "minio_latency_p95", "resource": "object_store", "unit": "seconds", "breach_above": 1.0 }
    ],
    "per_stage": [
      { "stage": "baseline", "tfe_pod_cpu": { "avg": 0.65, "p95": 0.84, "max": 0.90 }, "pg_conn_ratio": { "avg": 0.09, "p95": 0.11, "max": 0.12 }, "minio_latency_p95": { "avg": 0.04, "p95": 0.06, "max": 0.06 } },
      { "stage": "c10", "tfe_pod_cpu": { "avg": 1.73, "p95": 2.23, "max": 2.40 }, "pg_conn_ratio": { "avg": 0.22, "p95": 0.29, "max": 0.31 }, "minio_latency_p95": { "avg": 0.07, "p95": 0.08, "max": 0.09 } },
      { "stage": "c20", "tfe_pod_cpu": { "avg": 2.81, "p95": 3.63, "max": 3.90 }, "pg_conn_ratio": { "avg": 0.42, "p95": 0.54, "max": 0.58 }, "minio_latency_p95": { "avg": 0.11, "p95": 0.14, "max": 0.15 } },
      { "stage": "c25", "tfe_pod_cpu": { "avg": 3.31, "p95": 4.28, "max": 4.60 }, "pg_conn_ratio": { "avg": 0.63, "p95": 0.82, "max": 0.88 }, "minio_latency_p95": { "avg": 0.25, "p95": 0.32, "max": 0.34 } },
      { "stage": "c30", "tfe_pod_cpu": { "avg": 3.67, "p95": 4.74, "max": 5.10 }, "pg_conn_ratio": { "avg": 0.70, "p95": 0.90, "max": 0.97 }, "minio_latency_p95": { "avg": 0.45, "p95": 0.58, "max": 0.62 } }
    ],
    // first_bottleneck: the first resource over its breach_above at or before the knee — a pointer to where to look, not proof
    "first_bottleneck": { "resource": "postgres", "query": "pg_conn_ratio", "stage": "c25", "value": 0.88, "threshold": 0.85 }
  },
  "cleanup": { "workspaces_created": 1085, "workspaces_deleted": 1085, "force_deleted": 0, "leftover": 0, "result": "clean" },
  "grafana": { "annotations": { "status": "ok", "ids": [8841, 8842, 8843, 8844, 8845, 8846] } },
  "tfe": { "address": "https://tfe.example.internal", "version": "2.0.7", "organization": "existing-org", "api_rate_limit": 30 },
  "workload": { "config": "hold-30s", "tarball_url": "https://artifactory.example.internal/tfcap/hold-30s-v1.tar.gz",
                "tarball_sha256": "9f2c41d0…", "terraform_version": "1.9.8" },
  "harness": { "k6_version": "1.4.0", "host": "jump01", "k6_exit_code": 0,
               "started_at": "2026-11-23T14:05:02Z", "ended_at": "2026-11-23T15:53:22Z",
               "scenario_duration_sec": 6360, "clock_skew_ms": 120 },
  "config": { "...": "the effective scenario after defaults (see §Configuration format)" }
}
```

`runs.csv` excerpt (a real file has ~1,100 rows; the c30 errored row's error text is in `test.log`):

```
stage,vu,seq,workspace,run_id,outcome,created_at,pending_sec,plan_queue_sec,plan_sec,apply_queue_sec,apply_sec,run_sec,timed_out,force_deleted,has_changes
c20,12,4,k6cap-20261123-140500-a3f9-v12-i4,run-506bf2ef,applied,2026-11-23T15:01:33Z,0.4,3.5,14.2,2.1,38.8,59.4,false,false,true
c25,18,3,k6cap-20261123-140500-a3f9-v18-i3,run-faecbd38,applied,2026-11-23T15:18:32Z,0.5,14.9,18.6,4.8,40.6,79.8,false,false,true
c30,14,4,k6cap-20261123-140500-a3f9-v14-i4,run-f1d69ed6,errored,2026-11-23T15:40:17Z,0.6,27.3,20.5,,,48.8,false,false,true
```
```
# matching line in test.log:
TFEERR,run-f1d69ed6,apply errored: creating local_file: pq: remaining connection slots are reserved for non-replication superuser connections
```

How to read it: per-run time grows from 56 s at N=1 to 62 s at N=20, then 78 s at N=25, while
throughput stays ~17.5 runs/min — more slots stop producing more runs, the knee. Postgres connections
cross 0.85 at the same stage (0.88) while CPU and object storage stay under theirs. The recommendation
is 20, the highest stage below the knee where all signals pass and Postgres still has ~32% headroom;
confidence is low with one repeat.

## 6. Retention (manual)

Nothing is deleted automatically and there is no retention tooling. A test is a folder of three files;
`summary.json` and `runs.csv` are small (tens to a few hundred KB), `test.log` is the largest (order
of MB [V]). Delete a folder to drop a test. Keep the folders you rely on — the baseline run and the
run behind the recommended concurrency — and copy a finished folder somewhere team-owned; the jump
host is not a safe place for the only copy. Compare tests by opening their `summary.json` (the dated
folder names sort by time). Grafana annotations stay in Grafana, tagged `tfcap:<test-id>`; delete them
there if you want them gone (ids are under `grafana.annotations.ids`). Results carry addresses, org and
workspace names, and infra numbers but no tokens; treat the folder as internal (`umask 027`) and keep
`results/` out of shared repos.

## 7. Divergence from the parallel proposal

Adopted from it: the auditable `summary.json` (per-stage S1–S4, `analysis` with headroom/confidence/
method, `api`/`workspace_ops`, embedded `config`, `harness`), the terminal table as the human view, and
the step-by-step Grafana recipe with the variable/macro/one-series fixes. Kept from the earlier draft,
which that proposal lacked: the failure error + log tail captured **before** the workspace is deleted
(a capacity symptom vs a workload bug is otherwise unrecoverable), and **exact stage windows** from the
per-stage run model instead of a `TFESETUP_DONE` offset. The two proposals share the same `summary.json`
shape, so the only real difference left is how stages are driven (one run per stage here vs one
ramping-vus run), which does not change the result format.

## 8. Not verified

- Which annotations endpoint your Grafana serves (legacy `/api/annotations` vs the resource API), and
  the token permission for querying and for creating annotations.
- The Prometheus fields of `POST /api/ds/query` (`expr`, `range`) on your version, and that panel
  expressions work once variables and macros are replaced.
- Whether a tag-based dashboard annotation query renders the stage regions as expected.
- Whether the service-account token is shown only once.
- The real size of `test.log` for a full ladder.

## Sources

- [Grafana service accounts and tokens](https://grafana.com/docs/grafana/latest/administration/service-accounts/)
- [Grafana data source query API — `POST /api/ds/query`](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/data_source/)
- [Grafana annotations API — `POST /api/annotations`, region via `timeEnd`, epoch ms](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/annotations/)
- [k6 `handleSummary` — the only file-writing hook, runs even on abort](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/)
- [Prometheus HTTP API — `query_range`](https://prometheus.io/docs/prometheus/latest/querying/api/)
- Earlier k6 and TFE sources: the design document.
