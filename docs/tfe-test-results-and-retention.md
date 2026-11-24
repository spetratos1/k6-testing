# Test results and retention

Status: design, version 1. Replaces sections 10 and 11 of `tfe-capacity-test-design.md`. Tags:
**[F]** documented fact, **[R]** recommendation, **[V]** confirm in the pilot.

A capacity test produces one decision — a safe concurrency, the knee it sits below, and the resource
that gives out first — plus the evidence behind it. The output is built around that: one folder per
run, one file that is the result, one file of raw per-run rows behind it. Nothing else is kept.

Prometheus here keeps only 12 hours of data, and no test runs longer than that initially. Two
consequences: the infrastructure numbers are copied into the result folder at the end of the run (a
single pull, always inside the window — they cannot be fetched back once the window passes), and
retention of the results themselves is manual for now — results go in date-stamped folders and are
deleted by hand.

The jump host may call the Grafana HTTP API; Prometheus, the Kubernetes API, and the nodes stay out of
scope. Section 1 is the spike that proves the Grafana access; the rest is the output design.

## 1. Grafana access: the spike

Three things were checked from the jump host: get a token, read a metric, write a time-range
annotation. These are what the report step automates. `GRAFANA` is the base URL, `GRAFANA_TOKEN` the
token.

**Token.** Create a service account and a token for it (UI: Administration → Users and access →
Service accounts; or `POST /api/serviceaccounts` then `POST /api/serviceaccounts/:id/tokens`). [R]
Least privilege: `Viewer` can query a data source through the proxy; creating annotations needs
`Editor` or a custom role with `annotations:create`. [V] confirm the annotation permission on your
Grafana edition.

**Find the metric.** A metric is a data-source `uid` plus a PromQL expression. Read both from the
panel that already shows it: panel menu → Inspect → Panel JSON (`datasource.uid` and the `expr` under
`targets`). List uids with `GET /api/datasources`. Record each `{uid, expr}` in
`config/infra-queries.json`.

**Read a metric** through the data-source proxy, which passes straight to Prometheus. `START`/`END`
are Unix seconds spanning a stage's measure window, `STEP` seconds.

```bash
curl -s -G -H "Authorization: Bearer $GRAFANA_TOKEN" \
  "$GRAFANA/api/datasources/proxy/uid/$DS_UID/api/v1/query_range" \
  --data-urlencode 'query=sum(pg_stat_activity_count)/max(pg_settings_max_connections)' \
  --data-urlencode "start=$START" --data-urlencode "end=$END" --data-urlencode "step=$STEP"
# {"status":"success","data":{"resultType":"matrix","result":[{"values":[[1700000000,"0.62"], ...]}]}}
```

The report step runs one of these per stage per query and reduces the series to avg / p95 / max.

**Write a time-range annotation** — an organization annotation (no `dashboardUID`) with tags; a region
has both `time` and `timeEnd`, in epoch milliseconds.

```bash
curl -s -X POST -H "Authorization: Bearer $GRAFANA_TOKEN" -H "Content-Type: application/json" \
  "$GRAFANA/api/annotations" -d '{
    "time": 1700000000000, "timeEnd": 1700000900000,
    "tags": ["tfcap","tfcap:'"$TEST_ID"'","tfcap:stage:c15"],
    "text": "tfcap '"$TEST_ID"' stage c15" }'
# {"id":4412,"message":"Annotation added"}
```

It shows on any dashboard that has an annotation query filtering on the `tfcap` tag (dashboard
Settings → Annotations, Filter by Tags = `tfcap`); add that once per dashboard and every run's regions
appear without the harness knowing the dashboard. List or remove a run's markers with
`GET /api/annotations?tags=tfcap:$TEST_ID` and `DELETE /api/annotations/:id`. [V] Grafana 13 is moving
`/api` to `/apis`; the legacy paths used here still work — keep them in one place in the code.

## 2. The output

One folder per run, named with the date so it sorts and prunes by hand:
`results/<YYYYMMDD-HHMMSS>-<id>/`. Inside it, two files are the result:

- **`summary.json`** — the complete result. Everything needed to read, trust, and reproduce the run
  is in here: the verdict, the per-stage metrics with their infrastructure numbers, and the
  provenance. This is the one file a tool or a person reads.
- **`runs.jsonl`** — one JSON object per run, the raw rows behind the per-stage percentiles. Kept
  because a summary can't hold hundreds of runs and because it lets anyone recompute a statistic
  without k6 or Grafana.

That is the whole result. There is deliberately no separate `meta`, `infra`, `annotations`,
`cleanup`, or per-stage file — that information is sections inside `summary.json`, not copies of it in
other files. A readable table and the raw k6 sample stream are available on demand but not stored: a
`--report` flag renders `summary.json` as text, and `--raw` keeps k6's full JSON output for debugging
a harness problem. The wrapper and k6 also write a plain `run.log` for troubleshooting; it is a log,
not a result.

### `summary.json`

A full run: a c1 warmup/baseline, a 10→20→30 ladder stopped early at the knee, and a return-to-baseline
at c10. The numbers tell one story — throughput flattens from c20 to c30 while p95 run duration jumps
and the Postgres connection ratio crosses its 0.85 threshold, so the knee is c30 and the safe
concurrency is 24.

```jsonc
{
  "test_id": "20261123-150000-a1",
  "scenario": "state-heavy",
  "status": "stopped_knee",               // completed | stopped_knee | incomplete | aborted
  "started_at": "2026-11-23T15:00:12Z", "ended_at": "2026-11-23T16:28:40Z",
  "host": "jump-01", "k6_version": "0.54.0", "tfe_version": "v2.0.7",
  "workload": { "config": "state-heavy",
                "tarball_url": "https://artifactory.example.internal/tfe-loadtest/state-heavy-v1.tar.gz",
                "tarball_sha256": "9f2c…", "terraform_version": "1.9.8",
                "run_variables": { "mock_count": "50", "payload_kb": "100", "hold_seconds": "30" } },
  "observed_config": { "tfe_capacity_concurrency": 20, "terraform_enterprise_replicas": 3, "ceiling": 60 },
  "warnings": [],
  "stages": [
    { "label": "c1", "concurrency": 1, "role": "warmup", "regime": "below_ceiling",
      "window": { "start": "2026-11-23T15:01:00Z", "end": "2026-11-23T15:16:00Z" },
      "valid": true, "invalid_reason": null,
      "runs": { "created": 12, "completed": 12, "failed": 0 }, "throughput_per_min": 0.8,
      "queue_depth": { "avg": 0.0, "max": 0, "p95": 0 },
      "durations_sec": {
        "plan_queue": { "n": 12, "p50": 0.9, "p90": 1.4, "p95": 1.6, "max": 2 },
        "plan":        { "n": 12, "p50": 28, "p90": 33, "p95": 35, "max": 38 },
        "apply_queue": { "n": 12, "p50": 0.6, "p90": 1.2, "p95": 1.5, "max": 2 },
        "apply":       { "n": 12, "p50": 22, "p90": 26, "p95": 28, "max": 31 },
        "run":         { "n": 12, "p50": 58, "p90": 66, "p95": 70, "max": 78 } },
      "failures": [],
      "infra": { "postgres": { "avg": 0.12, "p95": 0.14, "max": 0.15 }, "cpu": { "max": 0.18 }, "memory": { "max": 0.50 } } },

    { "label": "c10", "concurrency": 10, "role": "ladder", "regime": "below_ceiling",
      "window": { "start": "2026-11-23T15:17:00Z", "end": "2026-11-23T15:34:00Z" },
      "valid": true, "invalid_reason": null,
      "runs": { "created": 40, "completed": 40, "failed": 0 }, "throughput_per_min": 2.0,
      "queue_depth": { "avg": 0.1, "max": 1, "p95": 1 },
      "durations_sec": {
        "plan_queue": { "n": 40, "p50": 1.2, "p90": 2.5, "p95": 3.0, "max": 6 },
        "plan":        { "n": 40, "p50": 30, "p90": 36, "p95": 40, "max": 52 },
        "apply_queue": { "n": 40, "p50": 0.8, "p90": 2.0, "p95": 3.0, "max": 5 },
        "apply":       { "n": 40, "p50": 24, "p90": 28, "p95": 31, "max": 40 },
        "run":         { "n": 40, "p50": 62, "p90": 74, "p95": 78, "max": 95 } },
      "failures": [],
      "infra": { "postgres": { "avg": 0.38, "p95": 0.42, "max": 0.45 }, "cpu": { "max": 0.40 }, "memory": { "max": 0.55 } } },

    { "label": "c20", "concurrency": 20, "role": "ladder", "regime": "below_ceiling",
      "window": { "start": "2026-11-23T15:35:00Z", "end": "2026-11-23T15:52:00Z" },
      "valid": true, "invalid_reason": null,
      "runs": { "created": 64, "completed": 63, "failed": 1 }, "throughput_per_min": 3.4,
      "queue_depth": { "avg": 0.6, "max": 4, "p95": 3 },
      "durations_sec": {
        "plan_queue": { "n": 63, "p50": 1.6, "p90": 3.5, "p95": 4.2, "max": 9 },
        "plan":        { "n": 63, "p50": 33, "p90": 42, "p95": 48, "max": 61 },
        "apply_queue": { "n": 63, "p50": 1.1, "p90": 2.8, "p95": 3.4, "max": 7 },
        "apply":       { "n": 63, "p50": 25, "p90": 30, "p95": 33, "max": 45 },
        "run":         { "n": 63, "p50": 72, "p90": 90, "p95": 95, "max": 120 } },
      "failures": [ { "reason": "errored", "count": 1 } ],
      "infra": { "postgres": { "avg": 0.66, "p95": 0.71, "max": 0.74 }, "cpu": { "max": 0.58 }, "memory": { "max": 0.60 } } },

    { "label": "c30", "concurrency": 30, "role": "ladder", "regime": "below_ceiling",
      "window": { "start": "2026-11-23T15:53:00Z", "end": "2026-11-23T16:10:00Z" },
      "valid": true, "invalid_reason": null,
      "runs": { "created": 60, "completed": 59, "failed": 1 }, "throughput_per_min": 3.6,
      "queue_depth": { "avg": 3.1, "max": 9, "p95": 7 },
      "durations_sec": {
        "plan_queue": { "n": 59, "p50": 6,  "p90": 14, "p95": 18, "max": 32 },
        "plan":        { "n": 59, "p50": 40, "p90": 55, "p95": 62, "max": 80 },
        "apply_queue": { "n": 59, "p50": 5,  "p90": 12, "p95": 16, "max": 28 },
        "apply":       { "n": 59, "p50": 28, "p90": 36, "p95": 41, "max": 58 },
        "run":         { "n": 59, "p50": 110, "p90": 132, "p95": 140, "max": 190 } },
      "failures": [ { "reason": "errored", "count": 1 } ],
      "infra": { "postgres": { "avg": 0.88, "p95": 0.92, "max": 0.94 }, "cpu": { "max": 0.76 }, "memory": { "max": 0.66 } } },

    { "label": "c10-return", "concurrency": 10, "role": "return", "regime": "below_ceiling",
      "window": { "start": "2026-11-23T16:11:00Z", "end": "2026-11-23T16:28:00Z" },
      "valid": true, "invalid_reason": null,
      "runs": { "created": 38, "completed": 38, "failed": 0 }, "throughput_per_min": 1.9,
      "queue_depth": { "avg": 0.1, "max": 1, "p95": 1 },
      "durations_sec": {
        "plan_queue": { "n": 38, "p50": 1.3, "p90": 2.6, "p95": 3.1, "max": 6 },
        "plan":        { "n": 38, "p50": 31, "p90": 37, "p95": 41, "max": 54 },
        "apply_queue": { "n": 38, "p50": 0.9, "p90": 2.1, "p95": 3.1, "max": 5 },
        "apply":       { "n": 38, "p50": 25, "p90": 29, "p95": 32, "max": 42 },
        "run":         { "n": 38, "p50": 64, "p90": 77, "p95": 82, "max": 98 } },
      "failures": [],
      "infra": { "postgres": { "avg": 0.40, "p95": 0.44, "max": 0.47 }, "cpu": { "max": 0.41 }, "memory": { "max": 0.56 } } }
  ],
  "result": {
    "knee_concurrency": 30,
    "limiting_signal": "p95_run_duration_rise",
    "safe_operating_concurrency": 24,
    "first_bottleneck": { "resource": "postgres", "query": "pg_conn_ratio", "stage": "c30", "value": 0.92, "threshold": 0.85 },
    "baseline_drift_pct": 5.1,
    "notes": "Knee below ceiling (60) => infrastructure-limited. Postgres connection ratio crossed 0.85 at c30 while p95 run duration rose 79% over the c10 baseline and throughput flattened (c20 3.4 -> c30 3.6/min). Ladder stopped after c30; c10-return drift +5.1%."
  },
  "grafana": { "status": "ok", "datasource_uid": "prom", "queries_sha256": "e3b0c4…", "annotation_ids": [4410, 4411, 4412, 4413, 4414] },
  "cleanup": { "workspaces_deleted": 214, "orphans": 0, "ok": true }
}
```

`grafana.status` is `ok`, `partial` (some queries failed — the failures and their errors are noted in
`warnings`), `unavailable`, or `disabled`. Every percentile carries `n`; a stage below
`min_completions_per_stage` is marked `valid: false`. Durations come from TFE's `status-timestamps`,
not the poll loop; `timed_out` runs are counted but excluded from the percentiles; warmup is excluded
from the window; no p99 under 100 samples. `first_bottleneck` is a heuristic — the resource whose
`breach_above` threshold is crossed at the lowest stage at or before the knee — and the per-stage
`infra` numbers are the evidence to check it.

### `runs.jsonl`

One line per run, across all stages. A failed run has a terminal `outcome` and null phase times past
the point it stopped; a `timed_out` run is kept (so it is counted) but excluded from the percentiles.

```json
{"stage":"c10","vu":3,"seq":4,"workspace":"k6cap-20261123-150000-a1-vu3-4","run_id":"run-5tQ","outcome":"applied","created_at":"2026-11-23T15:18:03Z","finished_at":"2026-11-23T15:19:09Z","plan_queue_sec":1.1,"plan_sec":31.4,"apply_queue_sec":0.7,"apply_sec":23.9,"run_sec":66.0,"timed_out":false,"has_changes":true}
{"stage":"c20","vu":11,"seq":9,"workspace":"k6cap-20261123-150000-a1-vu11-9","run_id":"run-8kR","outcome":"applied","created_at":"2026-11-23T15:41:22Z","finished_at":"2026-11-23T15:42:54Z","plan_queue_sec":2.0,"plan_sec":44.1,"apply_queue_sec":1.3,"apply_sec":30.2,"run_sec":92.0,"timed_out":false,"has_changes":true}
{"stage":"c20","vu":6,"seq":10,"workspace":"k6cap-20261123-150000-a1-vu6-10","run_id":"run-2mD","outcome":"errored","created_at":"2026-11-23T15:43:10Z","finished_at":"2026-11-23T15:44:01Z","plan_queue_sec":2.4,"plan_sec":48.0,"apply_queue_sec":null,"apply_sec":null,"run_sec":51.0,"timed_out":false,"has_changes":true}
{"stage":"c30","vu":22,"seq":7,"workspace":"k6cap-20261123-150000-a1-vu22-7","run_id":"run-9wF","outcome":"applied","created_at":"2026-11-23T15:55:40Z","finished_at":"2026-11-23T15:58:50Z","plan_queue_sec":17.2,"plan_sec":61.0,"apply_queue_sec":15.1,"apply_sec":40.4,"run_sec":190.0,"timed_out":false,"has_changes":true}
{"stage":"c30","vu":5,"seq":8,"workspace":"k6cap-20261123-150000-a1-vu5-8","run_id":"run-1xZ","outcome":"timed_out","created_at":"2026-11-23T15:59:05Z","finished_at":null,"plan_queue_sec":18.0,"plan_sec":null,"apply_queue_sec":null,"apply_sec":null,"run_sec":null,"timed_out":true,"has_changes":null}
```

### Comparing runs

A folder is one scenario run. With retention manual, comparison is manual too: the dated folders sort
by time, and each `result` block is the one-line verdict. Two runs, two scenarios:

```
results/
  20261123-150000-a1/   state-heavy  -> knee 30, safe 24, bottleneck postgres
  20261123-181500-b7/   plan-heavy   -> knee 20, safe 16, bottleneck cpu
```

```bash
for d in results/*/; do
  jq -c '{id:.test_id, scn:.scenario, safe:.result.safe_operating_concurrency, bn:.result.first_bottleneck.resource}' "$d/summary.json"
done
```

## 3. How it is generated

The result is a function of the run folder. The pieces that produce it, by responsibility — some exist
as scaffolding, the report step and the Grafana client are what remain to build:

| Piece | Responsibility | State |
|---|---|---|
| Wrapper | order the run; record each stage's exact wall-clock window; read Grafana clock skew once at start; create the dated folder (`umask 027`) | scaffolded |
| Validator | reject a malformed scenario before anything runs | built |
| Load step (one k6 run per stage) | hold C concurrent run lifecycles for the dwell; emit k6 metrics; write one `runs.jsonl` line per finished run | scaffolded |
| Knee check | after each stage, decide whether the knee is confirmed (early stop) | scaffolded |
| Cleanup | force-delete the run's workspaces | scaffolded |
| **Report step** | **to build** — read the folder, pull infra per stage window and post annotations from the recorded windows (Section 1), and write `summary.json` | not built |

Order: validate → for each stage { load, knee check, wrapper records the window } → cleanup → report
step. During the ladder the only external calls are to TFE. Grafana is touched once, at the end, by
the report step, from windows already on disk — so a slow or failed query never perturbs a
measurement. Initially no test runs longer than the 12-hour Prometheus window, so a single pull at the
end always falls inside it; the only rule is not to defer the report — `--report` can re-run against a
finished folder, but it recovers infra only within ~12 hours of the run, after which the live metrics
are gone (the numbers already captured in `summary.json` remain).

Because the per-run rows are logged during each stage, a kill mid-ladder still leaves `runs.jsonl` and
the finished stages; the report step then writes a `status: "incomplete"` summary with run counts and
completed stages, minus the knee. If the report step itself fails, the wrapper writes a minimal
`summary.json` from what is on disk, so a result always exists.

Infra queries live in `config/infra-queries.json` (operator-owned, because metric names belong to the
cluster, not the test); the scenario's `grafana` block holds only the connection and toggles and
points at it. Each query carries a `resource` group and an optional `breach_above` threshold; the file
is hashed into `grafana.queries_sha256` so a result states which queries produced it. Clock skew is
recorded at start and, above two seconds, warned about, since the query windows and annotation times
come from the jump-host clock.

```json
{ "version": 1, "queries": [
  { "id": "pg_conn_ratio", "resource": "postgres", "expr": "<PromQL>", "unit": "ratio", "breach_above": 0.85 }
]}
```

## 4. Retention

Manual for now. Each run writes a dated folder, `results/<YYYYMMDD-HHMMSS>-<id>/`, so old results are
found and removed by date with ordinary tools (`ls`, `find -mtime`, `rm`). There is no automatic
pruning, no policy file, and no size management in this version; if that becomes a burden we add a
small scheduled cleanup later.

The 12-hour limit is on Prometheus, not on the results: `summary.json` holds the infrastructure numbers
captured at the end of the run, so they survive even though the live metrics do not. Since a run fits
inside the window, the end-of-run pull always succeeds; only a report deferred past ~12 hours would
find the live metrics gone. Grafana
annotations are tagged `tfcap:<test-id>` and left in place (they are cheap and explain old dashboards);
remove a run's with the delete call in Section 1. TFE's own data — whether deleting a workspace also
clears its runs, logs, and state versions from Postgres and object storage — is the test's footprint,
measured in the pilot (design doc §12) and recorded under `cleanup` in `summary.json`.

[R] The jump host is scratch, not the system of record. Copy a run's folder (a few hundred KB) to
somewhere the team owns when it matters — the run that set your safe concurrency, and the pilot
baseline.

## 5. Not verified

- The service-account permission needed to create annotations on your Grafana edition.
- The proxy and annotation paths on your version (legacy `/api` vs the Grafana 13 `/apis` migration).
- Whether a tag-based dashboard annotation query renders regions as expected.

## Sources

- [Grafana data source API — proxy `/api/datasources/proxy/uid/:uid/*`](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/data_source/)
- [Grafana annotations API — `POST /api/annotations`, region via `timeEnd`, epoch ms](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/annotations/)
- [Prometheus HTTP API — `query_range`](https://prometheus.io/docs/prometheus/latest/querying/api/)
- Earlier k6 and TFE sources: the design document.
