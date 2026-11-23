# Test results and retention strategy

Status: design, version 1. This replaces sections 10 and 11 of `tfe-capacity-test-design.md`; where
they disagree, this document is correct. Tags: **[F]** documented fact, **[R]** recommendation,
**[V]** to confirm against your Grafana/TFE in the pilot.

The harness that produces these results is still being built. This document defines the output, the
files, how they are generated, and how long they are kept, and it names the pieces of the harness
that have to exist to do that — it does not assume any particular script is already written. The one
thing that was actually tried, because the whole infrastructure story depends on it, is the Grafana
access; that spike is Section 1.

One earlier constraint is reversed here, with your confirmation: the jump host may call the Grafana
HTTP API. Prometheus, the Kubernetes API, and the nodes stay out of scope — Prometheus is reached only
through a Grafana data source, and every Grafana call is outbound and authenticated.

## 1. Grafana access: the spike

Before relying on Grafana for the "what saturated first" answer, we proved three things from the jump
host: you can get a token, you can read a metric with it, and you can write a time-range annotation.
The steps below are what the report step automates later. Commands assume `GRAFANA` holds the base
URL and `GRAFANA_TOKEN` holds the token.

### 1.1 Get a token

Create a **service account** and a token for it, rather than a personal API key. In the UI:
Administration → Users and access → Service accounts → Add service account, then Add service account
token. The same by API:

```bash
# create the service account (needs an admin token once, to bootstrap)
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$GRAFANA/api/serviceaccounts" \
  -d '{"name":"tfe-captest","role":"Viewer"}'
# -> {"id": 42, ...}

# mint a token for it
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  "$GRAFANA/api/serviceaccounts/42/tokens" \
  -d '{"name":"tfe-captest-token"}'
# -> {"key":"glsa_..."}   # this is GRAFANA_TOKEN
```

[R] Least privilege: `Viewer` is enough to **query** a data source through the proxy. **Creating
annotations** needs more — either the `Editor` role, or (better) a custom role granting
`annotations:create` and nothing else. Give the account read on the one data source you query and
annotation-create, and no dashboards-edit. [V] Confirm the exact role/permission on your Grafana;
RBAC for annotations varies by version and edition.

### 1.2 Identify the metric and the data source

A metric is identified by two things: the data source `uid` and the PromQL expression. The easiest way
to get both is from the panel that already shows what you care about. Open the dashboard, pick the
panel (say "Postgres connections"), then its menu → Inspect → Panel JSON, and read the `datasource.uid`
and the `expr` out of `targets`. (Query inspector → "Query" shows the same expression.) You can also
list data sources and their uids directly:

```bash
curl -s -H "Authorization: Bearer $GRAFANA_TOKEN" "$GRAFANA/api/datasources" \
  | python3 -c 'import sys,json;[print(d["uid"],d["type"],d["name"]) for d in json.load(sys.stdin)]'
```

Record each `{uid, expr}` you want into `config/infra-queries.json` (Section 4). The harness ships no
metric names of its own, because they are specific to your exporters.

### 1.3 Read a metric

Query through the **data source proxy**, which passes straight to Prometheus and returns native
Prometheus JSON. `DS_UID` is the data source uid; `START`/`END` are Unix seconds spanning a stage's
measure window; `STEP` is seconds.

```bash
curl -s -G -H "Authorization: Bearer $GRAFANA_TOKEN" \
  "$GRAFANA/api/datasources/proxy/uid/$DS_UID/api/v1/query_range" \
  --data-urlencode 'query=sum(pg_stat_activity_count) / max(pg_settings_max_connections)' \
  --data-urlencode "start=$START" \
  --data-urlencode "end=$END" \
  --data-urlencode "step=$STEP"
# -> {"status":"success","data":{"resultType":"matrix",
#     "result":[{"metric":{...},"values":[[1700000000,"0.62"],[1700000015,"0.66"], ...]}]}}
```

The report step runs one of these per stage per query and reduces each series' values to `avg`, `p95`,
and `max` over the window. (The unified `POST /api/ds/query` endpoint also works and can batch several
queries in one call, but its Prometheus body fields are less clearly documented; the proxy
`query_range` is the simpler, well-specified path, so it is the one we build on. [V] confirm the proxy
path on your version.)

### 1.4 Write a time-range annotation

Post an **organization annotation** (no `dashboardUID`) with tags. A region is created by including
both `time` and `timeEnd`, both in **epoch milliseconds**.

```bash
curl -s -X POST -H "Authorization: Bearer $GRAFANA_TOKEN" -H "Content-Type: application/json" \
  "$GRAFANA/api/annotations" -d '{
    "time":    1700000000000,
    "timeEnd": 1700000900000,
    "tags":    ["tfcap", "tfcap:'"$TEST_ID"'", "tfcap:stage:c15"],
    "text":    "tfcap '"$TEST_ID"' stage c15 measure window"
  }'
# -> {"id": 4412, "message": "Annotation added"}
```

Where it shows up: an organization annotation is not tied to a dashboard, so it appears on any
dashboard that has an annotation query filtering on the tag. Add that once per dashboard (dashboard
Settings → Annotations → add a "Grafana" annotation query with `Filter by: Tags = tfcap`), and every
test's regions light up on it without the harness knowing the dashboard. To pin a marker to one
dashboard instead, include its `dashboardUID` (and optionally `panelId`).

### 1.5 Find and remove them later

```bash
curl -s -G -H "Authorization: Bearer $GRAFANA_TOKEN" "$GRAFANA/api/annotations" \
  --data-urlencode "tags=tfcap:$TEST_ID"                 # list a test's annotations
curl -s -X DELETE -H "Authorization: Bearer $GRAFANA_TOKEN" "$GRAFANA/api/annotations/4412"
```

Annotations live in the Grafana database, tagged with the test id, so they are cheap to keep and easy
to find or delete by test. [V] Grafana 13 is migrating `/api` to `/apis`; the legacy `/api/annotations`
and `/api/datasources/proxy` paths used here still work, but keep the paths in one place so a version
bump is a one-line change.

## 2. Decisions

1. One folder per test, `results/<test-id>/`, self-contained: the answer, the evidence, and the
   scenario and environment needed to read it later.
2. `summary.json` is the result; `report.md` is the same thing written for a person. A person reads
   `report.md`; a tool reads `summary.json`. Nothing else is needed to get the answer.
3. Infrastructure evidence is pulled from Grafana into the folder (`infra.json`) as soon as the ladder
   finishes, so the numbers outlive Prometheus retention and "what saturated first" is answered from
   the folder, not from a live dashboard weeks later.
4. Grafana is used for exactly two things, both shown in Section 1: reading metrics and writing
   annotations. The test never waits on it and never fails because of it. No token, unreachable API,
   or failed query leaves you without a result — the infra section just records why it is thin.
5. Grafana is touched only after the load is over. Nothing talks to it while runs are in flight, so a
   slow query or a flaky endpoint can never perturb a measurement.
6. Retention is by file class, in its own policy file, not per scenario. Small decision-grade files
   are kept indefinitely; per-run records for 180 days; bulky raw output for 30. A reference test can
   be pinned so pruning never touches it.

We do not reconstruct stage windows from a setup marker and offsets, the way a single-run ladder would
have to. Because each concurrency stage is its own k6 run, the harness records every stage's exact
wall-clock window directly, and those windows are what the Grafana queries and annotations use.

## 3. What the results answer

Five questions, each with a home in the output.

| Question | Answered by |
|---|---|
| Can I trust this run? | `status`; per-stage `valid` / `invalid_reason`; `warnings`; `infra.status`; `cleanup.ok` |
| Where is the knee? | `result.knee_concurrency`, `result.limiting_signal` |
| What concurrency is safe? | `result.safe_operating_concurrency`, with the signal and the regime |
| When does queueing start? | per stage: `durations_seconds.plan_queue` / `apply_queue`, `queue_depth` |
| What saturates first? | `infra.first_bottleneck` and the per-stage resource numbers in `infra.json` |

Rules that hold for every number. Percentiles always carry their sample count `n`, and a stage with
fewer than `min_completions_per_stage` measured runs is marked invalid rather than quietly averaged.
Phase durations come from TFE's `status-timestamps`, not our poll loop, so poll granularity and
jump-host/TFE clock skew never leak into them. A `timed_out` run is counted and shown but kept out of
the duration percentiles. Warmup is excluded from the measured window. No p99 for a stage under 100
samples. The bottleneck call is a heuristic, not a proof: `first_bottleneck` names the resource whose
configured `breach_above` threshold was crossed at the lowest stage at or before the knee, and the
evidence to check it is in `infra.json`.

## 4. Files produced

```
results/
  index.csv                        one row per test, appended — cross-test comparison
  <test-id>/
    summary.json                   the result                              keep
    report.md                      human rendering of summary.json         keep
    infra.json                     Grafana metrics per stage window        keep
    annotations.json               annotation ids posted to Grafana        keep
    meta.json                      wall-clock, host, k6 version, skew       keep
    scenario.effective.json        scenario after defaults                 keep
    cleanup.json                   cleanup result                          keep
    manifest.json                  every file with size and sha256         keep
    summary-stage-<label>.json     per-stage metrics from k6               medium
    runs.jsonl                     one record per run                      medium
    runs.csv                       same, for spreadsheets                  medium
    test.log                       per-run log lines from each stage       short
    metrics-stage-<label>.ndjson   k6 raw samples (optional)               short
```

Test id is `YYYYMMDD-HHMMSS-<4hex>` and appears in the folder name, the workspace names, the annotation
tags, and the `index.csv` row, so any artifact traces back to its run.

The per-run record in `runs.jsonl` is what lets anyone recompute a statistic without k6 or Grafana:

```json
{"stage":"c15","vu":7,"seq":12,"workspace":"k6cap-20261123-140800-ab-vu7-12",
 "run_id":"run-AbC...","outcome":"applied","created_at":"...","finished_at":"...",
 "plan_queue_sec":2.1,"plan_sec":9.8,"apply_queue_sec":1.9,"apply_sec":31.2,"run_sec":46.0,
 "timed_out":false,"has_changes":true}
```

`summary.json` keeps the shape from design doc §11 and adds `warnings`, `infra`, `grafana`, `files`:

```json
{
  "schema_version": "2",
  "warnings": ["grafana clock skew 2.4s exceeds 2s"],
  "infra": {
    "status": "ok",
    "source": { "grafana": "https://grafana.example.internal", "datasource_uid": "prom", "queries_sha256": "..." },
    "clock_skew_ms": 2400,
    "first_bottleneck": { "resource": "postgres", "query": "pg_conn_ratio", "stage": "c25", "value": 0.92, "threshold": 0.85 },
    "per_stage": [ { "stage": "c25", "cpu": { "max": 0.71 }, "postgres": { "max": 0.92 }, "memory": { "max": 0.64 } } ]
  },
  "grafana": { "annotations": { "status": "ok", "count": 14, "ids_file": "annotations.json" } },
  "files": { "manifest": "manifest.json", "retention_class": "keep", "pinned": false }
}
```

`infra.status` is `ok`, `partial` (some queries failed — listed in `infra.json`), `unavailable`
(Grafana could not be reached), or `disabled` (not turned on). `report.md` renders the same content in
a fixed order — verdict, warnings, per-stage table, per-stage resource table, cleanup, file list — and
carries nothing that is not in `summary.json`. `index.csv` is append-only: `test_id, started_at,
status, scenario, profile, terraform_version, tfe_version, max_concurrency, knee_concurrency,
safe_concurrency, first_bottleneck, invalid_stages, pinned, path`.

## 5. What the harness needs to produce this

The results are a function of the test folder, generated by the pieces below. Some already exist as
scaffolding from earlier work; the report step and the Grafana client are the main things still to
build. The design depends on the **responsibilities**, not on these names.

| Piece | Responsibility | Reads | Writes | State |
|---|---|---|---|---|
| Wrapper | orders the run; records each stage's exact wall-clock window; checks Grafana clock skew once at start; at the end writes `manifest.json` and the `index.csv` row; sets `umask 027` | scenario, `retention.json` | `meta.json`, `manifest.json`, `index.csv` | scaffolded |
| Validator | reject a malformed scenario before anything runs | scenario, schema | `validation.json` | built |
| Load step (one run per stage) | hold C concurrent run lifecycles for the dwell; emit k6 metrics; log one line per finished run | scenario, workload tarball | `summary-stage-<label>.json`, `test.log` lines | scaffolded |
| Knee check | after each stage, decide whether the knee is confirmed (early stop) | stage summaries | early-stop signal | scaffolded |
| Cleanup step | force-delete the test's workspaces; report leftovers | TFE API | `cleanup.json` | scaffolded |
| **Report step** | **to build.** Read the folder; pull infra per stage window and post annotations from the recorded windows (Section 1); parse `test.log` into `runs.jsonl`/`runs.csv`; merge everything into `summary.json` and render `report.md` | folder, `infra-queries.json`, Grafana | `runs.jsonl`, `runs.csv`, `infra.json`, `annotations.json`, `summary.json`, `report.md` | **not built** |
| Prune | enforce `retention.json` | `retention.json`, `results/` | deletes / compresses | built |

The order they run in:

```
validate scenario
for each stage (and the return-to-baseline stage):
    load step   -> summary-stage-<label>.json, test.log lines
    knee check  -> early-stop decision
    wrapper records the stage's start/end window
cleanup step    -> cleanup.json        (always, even after a kill)
report step     -> runs.jsonl, runs.csv, infra.json, annotations.json, summary.json, report.md
wrapper         -> manifest.json, append index.csv
```

Two properties make this robust. First, the load path and the Grafana path are separate: during the
ladder the only external calls are to TFE; infra queries and annotations happen afterward, in the
report step, from windows already on disk. That keeps Grafana latency and failures off the
measurement, and it means **the report step can be re-run on its own** against a finished folder — to
recover from a Grafana outage while Prometheus still holds the data, or to recompute the infra section
after changing queries or thresholds — without re-running the load. Posting is idempotent: the step
reads `annotations.json` first and skips anything already posted.

Second, the report step degrades. Because k6 can only write files from `handleSummary`, per-run detail
is logged during each stage and parsed afterward, so a kill mid-ladder still leaves `test.log` and the
finished stage summaries; the report step then produces a `status: "incomplete"` summary with run
counts and completed stages, minus the knee analysis. If the report step itself fails, the wrapper
writes a minimal `summary.json` from the stage files, so a result always exists.

## 6. Grafana integration decisions

The mechanics are in Section 1; this section is the design around them.

Queries live in their own file, `config/infra-queries.json`, not in the scenario, because metric names
belong to the cluster, not to a test. The operator owns this file; the scenario's `grafana` block only
holds the connection and toggles and points at it with `queries_file`.

```json
{
  "version": 1,
  "queries": [
    { "id": "tfe_pod_cpu",   "resource": "cpu",      "title": "TFE pods CPU (cores)",       "expr": "<PromQL>", "unit": "cores", "breach_above": 6.0 },
    { "id": "pg_conn_ratio", "resource": "postgres", "title": "Postgres connections / max", "expr": "<PromQL>", "unit": "ratio", "breach_above": 0.85 }
  ]
}
```

`resource` is one of `cpu`, `memory`, `disk`, `postgres`, `redis`, `object_store`, `network`, `other`;
it groups the resource table and names the bottleneck. `expr` should already reduce to a handful of
series (`max by (pod)` and the like); at most 20 series per query are stored per stage, more is
recorded as truncated. `breach_above` is the threshold that makes a resource eligible to be named the
first bottleneck; without it a query is reported but never named. The file is hashed into
`infra.source.queries_sha256`, so a result states which queries produced it.

Annotations are posted after the ladder from the recorded windows, never live (decision 5). Tag scheme:
`tfcap`, `tfcap:<test-id>`, `tfcap:stage:<label>` on each stage region, plus `tfcap:knee` at the knee
and a `tfcap`/`tfcap:<test-id>` point at test start and end. Prefer the tag-filtered dashboard
annotation query (Section 1.4) over posting to specific dashboards, so markers appear everywhere
without the harness knowing your dashboards.

Clock skew is the one thing that can quietly corrupt the infra section, since query windows and
annotation times come from the jump-host clock. At the start of a run the wrapper compares the `Date`
header of a Grafana response with the local clock and records `clock_skew_ms` in `meta.json`; above two
seconds it adds a warning, and stage-level resource numbers should not be trusted when the skew exceeds
the query step.

On failure each query gets a timeout and one retry; a query that still fails is written to `infra.json`
with its error and `infra.status` becomes `partial`. Nothing on the Grafana path can change the test's
`status` or exit code.

## 7. Retention

Retention is a property of the results directory, not of any one test, so it has its own file.

| Class | Files | Why | Default |
|---|---|---|---|
| keep | `summary.json`, `report.md`, `infra.json`, `annotations.json`, `meta.json`, `scenario.effective.json`, `cleanup.json`, `manifest.json`, `index.csv` | the decision and its evidence; all small | indefinite |
| medium | `summary-stage-*.json`, `runs.jsonl`, `runs.csv` | enough to recompute statistics | 180 days |
| short | `test.log`, `metrics-stage-*.ndjson` | bulky; only needed to debug the harness | 30 days |

[R] Measure the real sizes in the pilot. Keep and medium are kilobytes to a few MB per test; the raw
k6 JSON is the large one (a point per sample, several per HTTP request), on the order of a hundred MB
before gzip for a multi-hour ladder and roughly a tenth of that after. Set the short-class cap from the
measured figure.

The policy lives in `config/retention.json`:

```json
{
  "version": 1,
  "results_dir": "results",
  "classes": {
    "keep":   { "max_age_days": null },
    "medium": { "max_age_days": 180 },
    "short":  { "max_age_days": 30, "max_total_mb": 5000 }
  },
  "pinned": { "protect": true },
  "grafana": { "delete_annotations_with_results": false }
}
```

Pruning is a separate, explicit step (`tools/prune-results.sh`, dry run by default, `--apply` to
delete); a test run never deletes older results. It removes files past their class age first, then, if
`max_total_mb` is still exceeded, the oldest short-class files; keep-class files are never size-pruned.
A pinned test is exempt — pin it by setting `"pinned": true` in its `summary.json` (an empty `PINNED`
file does the same), and pin the run that established your safe concurrency and the pilot that set the
baseline, since later runs are read against them. A pruned file stays listed in `manifest.json` with
the date and reason, and `index.csv` rows are never removed, so a gap is always explained. Incomplete,
aborted, and invalid tests age out on the same schedule; they are evidence about how the harness fails.

Three things sit outside the folder. Prometheus and Grafana metric retention belong to the platform
team and are not managed here — which is exactly why `infra.json` copies the numbers in immediately; if
the report step could not collect them, re-run it before the platform's window closes. Grafana
annotations are small, tagged `tfcap:<test-id>`, and left in place by default
(`delete_annotations_with_results: false`) because they are cheap and explain old dashboards; erase a
run's markers with the delete call in Section 1.5. TFE's own data is the test's footprint, not its
result: cleanup deletes the workspaces, and whether that also clears the runs, logs, and state-version
rows from Postgres and object storage is measured in the pilot (design doc §12) and recorded in
`cleanup.json`.

[R] Treat the jump host as scratch, not the system of record. After each test, copy the keep class — a
few hundred KB — somewhere the team owns (Artifactory, or the change record). Results carry the TFE and
Grafana addresses, the org and workspace names, the Artifactory URL, and infra metrics, but no tokens:
scenarios store env-var names only and the client never logs the `Authorization` header. Treat the
folder as internal — create it with `umask 027` (mode 0750) and keep `results/` out of shared repos.

## 8. What this changes elsewhere

Design doc §10 and §11 are superseded here. In the configuration format the `grafana` block points at
`infra-queries.json` through `queries_file` instead of listing metrics inline, and the scenario no
longer carries a `retention` block — retention moved to `retention.json`. The schema, the validator,
and the format document were updated together.

## 9. Not verified

- The service-account role/permission needed to create annotations on your Grafana version and edition.
- The proxy path (`/api/datasources/proxy/uid/:uid/api/v1/query_range`) and the annotation path on your
  version (legacy `/api` vs the Grafana 13 `/apis` migration).
- Whether a tag-based dashboard annotation query renders regions as expected on your dashboards.
- The real on-disk size of `test.log` and the raw k6 output for a full ladder.
- Whether your Grafana expires annotations on its own.

## Sources

- [Grafana data source API — proxy `GET /api/datasources/proxy/uid/:uid/*`](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/data_source/)
- [Grafana annotations API — `POST /api/annotations`, region via `timeEnd`, epoch ms](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/annotations/)
- [Grafana service accounts and tokens](https://grafana.com/docs/grafana/latest/administration/service-accounts/)
- [Prometheus HTTP API — `query_range`](https://prometheus.io/docs/prometheus/latest/querying/api/)
- [k6 JSON output, gzipped when the filename ends in `.gz`](https://grafana.com/docs/k6/latest/results-output/real-time/json/)
- Earlier k6 and TFE sources are in the design document.
