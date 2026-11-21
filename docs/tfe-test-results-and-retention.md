# Test results and retention strategy

Status: design, version 1. This replaces sections 10 and 11 of `tfe-capacity-test-design.md`; where
they disagree, this document is correct. Tags: **[F]** documented fact, **[R]** recommendation,
**[V]** to confirm in the pilot.

One earlier constraint is reversed here, with your confirmation: the jump host may call the Grafana
HTTP API. Prometheus, the Kubernetes API, and the nodes stay out of scope — Prometheus is reached only
as a Grafana data source, and every Grafana call is outbound and authenticated.

## Decisions

1. One folder per test, `results/<test-id>/`, self-contained. It holds the answer, the evidence
   behind the answer, and the scenario and environment needed to read it later.
2. `summary.json` is the result. `report.md` is the same thing written for a person. If you only read
   one file, read `report.md`; if a tool reads one file, it reads `summary.json`. Nothing else is
   needed to get the answer.
3. Infrastructure evidence is pulled from Grafana straight into the folder (`infra.json`) as soon as
   the ladder finishes. Those numbers then outlive Prometheus retention, and the "what saturated
   first" question is answered from the folder rather than from a live dashboard weeks later.
4. Grafana does exactly two things: it answers metric queries and it receives annotations. The test
   never waits on it and never fails because of it. If the token is missing, the API is unreachable,
   or a query errors, the result is still produced and records why the infra section is thin.
5. The result is assembled by a re-runnable step after the load is over. Nothing about generating
   results, talking to Grafana, or writing files happens while runs are in flight, so a slow or
   broken Grafana never perturbs a measurement.
6. Retention is set by file class, in its own policy file, not per scenario. Small decision-grade
   files are kept indefinitely; per-run records for 180 days; bulky raw output for 30. A reference
   test can be pinned so pruning never touches it.

One thing we do *not* copy from the single-run design this document was compared against: there is no
`setup`-done marker and no stage-offset arithmetic. Because each concurrency stage is its own
`k6 run`, the wrapper already knows every stage's exact wall-clock window. Those windows are what the
Grafana queries and annotations use, so they are precise by construction rather than reconstructed
from logs.

## What the results answer

The test exists to answer five questions, and each has a home in the output.

| Question | Answered by |
|---|---|
| Can I trust this run? | `status`; per-stage `valid` / `invalid_reason`; `warnings`; `infra.status`; `cleanup.ok` |
| Where is the knee? | `result.knee_concurrency`, `result.limiting_signal` |
| What concurrency is safe? | `result.safe_operating_concurrency`, with the signal and the regime |
| When does queueing start? | per stage: `durations_seconds.plan_queue` / `apply_queue`, `queue_depth` |
| What saturates first? | `infra.first_bottleneck` and the per-stage resource numbers in `infra.json` |

A few rules hold for every number we report. Percentiles always travel with their sample count `n`,
and a stage with fewer than `min_completions_per_stage` measured runs is marked invalid rather than
quietly averaged. Phase durations come from TFE's `status-timestamps`, not from our poll loop, so poll
granularity and clock skew between the jump host and TFE never leak into them. A `timed_out` run is
counted and shown but kept out of the duration percentiles, because its real duration is unknown and
it would otherwise pin everything at `max_run_wait`. Warmup is excluded from the measured window. We
do not report p99 for a stage with fewer than 100 samples. And the bottleneck call is a heuristic,
not a proof: `first_bottleneck` points at the resource whose configured threshold was crossed at the
lowest stage at or before the knee, and the evidence to check it is in `infra.json`.

## Files produced

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
    metrics-stage-<label>.ndjson   k6 raw samples (optional, --out json)   short
```

Test id is `YYYYMMDD-HHMMSS-<4hex>`, and it shows up in the folder name, the workspace names, the
annotation tags, and the `index.csv` row, so any artifact can be traced back to its run.

| File | Written by | When | Notes |
|---|---|---|---|
| `meta.json` | wrapper | start, finished at end | start/end wall-clock, host, k6 version, workload URL + sha256, measured Grafana clock skew |
| `scenario.effective.json` | wrapper | start | exactly what ran; env-var names only, no secrets |
| `summary-stage-<label>.json` | `stage.js` `handleSummary` | end of each stage | that stage's percentiles, throughput, queue depth, counts |
| `test.log` | `stage.js` (`console.log`, redirected) | during each stage | one JSON line per finished run |
| `metrics-stage-<label>.ndjson` | k6 `--out json` | during | opt-in; large, includes built-in HTTP metrics |
| `cleanup.json` | `cleanup.js` | after the ladder, always | workspaces found, canceled, deleted, orphaned |
| `runs.jsonl` / `runs.csv` | report step | after cleanup | parsed from `test.log` |
| `infra.json` | report step | after cleanup | Grafana queries per stage window |
| `annotations.json` | report step | after infra | annotation ids and times |
| `summary.json` / `report.md` | report step | last | merge of everything |
| `manifest.json` / `index.csv` | wrapper (shell) | last | sha256 of each file; one appended CSV row |

The per-run record in `runs.jsonl` is the thing that lets anyone recompute a statistic without k6 or
Grafana:

```json
{"stage":"c15","vu":7,"seq":12,"workspace":"k6cap-20261120-205300-ab-vu7-12",
 "run_id":"run-AbC...","outcome":"applied","created_at":"...","finished_at":"...",
 "plan_queue_sec":2.1,"plan_sec":9.8,"apply_queue_sec":1.9,"apply_sec":31.2,"run_sec":46.0,
 "timed_out":false,"has_changes":true}
```

`summary.json` keeps the shape from design doc §11 and adds `warnings`, `infra`, `grafana`, and
`files`:

```json
{
  "schema_version": "2",
  "warnings": ["grafana clock skew 2.4s exceeds 2s"],
  "infra": {
    "status": "ok",
    "reason": null,
    "source": { "grafana": "https://grafana.example.internal", "datasource_uid": "prom", "queries_sha256": "..." },
    "clock_skew_ms": 2400,
    "first_bottleneck": { "resource": "postgres", "query": "pg_conn_ratio", "stage": "c25", "value": 0.92, "threshold": 0.85 },
    "per_stage": [ { "stage": "c25", "cpu": { "max": 0.71 }, "postgres": { "max": 0.92 }, "memory": { "max": 0.64 } } ]
  },
  "grafana": { "annotations": { "status": "ok", "count": 14, "ids_file": "annotations.json" } },
  "files": { "manifest": "manifest.json", "retention_class": "keep", "pinned": false }
}
```

`infra.per_stage` is the compact view — one number per resource per stage. The full per-series
statistics live in `infra.json`. `infra.status` is `partial` when some queries failed (the failures
are listed in `infra.json`), `unavailable` when Grafana could not be reached, and `disabled` when the
scenario did not turn it on.

`report.md` has a fixed order and carries nothing that is not already in `summary.json`: the verdict
(status, knee, safe concurrency, regime), then warnings, then a per-stage table (runs, throughput,
p50/p90/p95/max of queue wait and run duration with `n`, failures), then the per-stage resource table
from `infra.json`, then the cleanup outcome and the file list.

`index.csv` is append-only, one row per test, and is all you need to compare runs over time:
`test_id, started_at, status, scenario, profile, terraform_version, tfe_version, max_concurrency,
knee_concurrency, safe_concurrency, first_bottleneck, invalid_stages, pinned, path`.

## How results are generated

```
run_test.sh
  validate -> resolve -> guard -> fetch+hash workload (meta.json start)
  for each stage C (and the return-to-baseline stage):
      k6 run stage.js      -> summary-stage-<C>.json, test.log lines
      k6 run evaluate.js   -> decision.env (knee; early stop if configured)
      record the stage's exact wall-clock window
  k6 run cleanup.js        -> cleanup.json      (always, even after a kill)
  finish meta.json (end, k6 exit codes)
  REPORT STEP (re-runnable):
      k6 run report.js
        reads   summary-stage-*.json, test.log, meta.json, cleanup.json,
                scenario.effective.json, the recorded stage windows, infra-queries.json
        calls   Grafana: /api/ds/query per stage window, then annotations
        writes  runs.jsonl, runs.csv, infra.json, annotations.json, summary.json, report.md
  shell: manifest.json (sha256 of each file), append index.csv, chmod 0750
```

The load path and the reporting path are separate on purpose. During the ladder the only external
calls are to TFE; Grafana is touched only afterward, by the report step. That keeps a slow query or a
flaky annotation endpoint off the measurement, and it means the report step can be run again on its
own without re-running the load.

Re-runnability is the main thing I took from the comparison. `run_test.sh --report <test-id>` repeats
only the report step against a folder that already has its stage summaries and logs. Two cases make
this worth it: a Grafana outage during the original run (retry while Prometheus still holds the data),
and a changed set of queries or thresholds (recompute the infra section and the bottleneck call
without touching TFE). Annotation posting is idempotent — the step reads `annotations.json` first and
skips anything already posted, so a second run does not double-annotate.

Because k6 can only write files from `handleSummary`, per-run detail is logged during the stage and
parsed afterward. A side benefit is graceful failure: if k6 is killed mid-ladder, `test.log` and the
finished stage summaries are still on disk, and the report step produces a `status: "incomplete"`
summary with run counts and whatever stages completed, minus the knee analysis. If the report step
itself fails, the wrapper writes a minimal `summary.json` from the stage files so a result always
exists.

Everything the report step produces is a function of the folder. `runs.jsonl`, the stage summaries,
`scenario.effective.json`, and `infra.json` are enough to recompute the knee with different thresholds
later, in a spreadsheet or a script, without k6 in the loop.

## Grafana integration

Scope is read metrics, write annotations, nothing else. Both are optional and gated by the `grafana`
block in the scenario (see `tfe-test-configuration-format.md`).

Credentials are a Grafana service-account token in the env var named by `grafana.token_env` (default
`GRAFANA_TOKEN`). [R] Scope the service account to querying the one data source and creating
annotations, nothing more. If the variable is unset the Grafana steps are skipped, `infra.status`
becomes `disabled`, and a warning is recorded.

The queries live in their own file, `infra-queries.json`, not in the scenario. Metric names are
specific to the cluster's exporters, not to a test, so the operator owns this file and the harness
ships none of its own. The scenario points at it with `grafana.queries_file`.

```json
{
  "version": 1,
  "queries": [
    { "id": "tfe_pod_cpu",   "resource": "cpu",      "title": "TFE pods CPU (cores)",        "expr": "<PromQL>", "unit": "cores", "breach_above": 6.0 },
    { "id": "pg_conn_ratio", "resource": "postgres", "title": "Postgres connections / max",  "expr": "<PromQL>", "unit": "ratio", "breach_above": 0.85 }
  ]
}
```

`resource` is one of `cpu`, `memory`, `disk`, `postgres`, `redis`, `object_store`, `network`,
`other`; it groups the resource table and names the bottleneck. `expr` should already reduce to a
handful of series (`max by (pod)` and the like); at most 20 series per query are stored per stage, and
anything beyond that is recorded as truncated. `breach_above` is the threshold that makes a resource
eligible to be named the first bottleneck; a query without one is reported but never named. The file
is hashed into `infra.source.queries_sha256`, so a result states which queries produced it. No example
expressions are shipped because they depend entirely on your exporters.

For each stage and each query, the step runs one range query over the stage's measure window through
`POST /api/ds/query` with the data source `uid`, `from`/`to` in epoch milliseconds, and a step from
`grafana.step_sec`. [V] The endpoint, `queries`, `datasource.uid`, and `from`/`to` are documented; the
Prometheus-specific body fields such as `expr` are not on that page, so confirm the exact request
against your Grafana version in the pilot. Per series it stores `avg`, `p95`, `max`, and the sample
count for the window, plus the same for the 60 seconds before the stage as a short reference line.

Annotations are posted after the ladder, from the recorded stage windows, never live:

| Annotation | Kind | Tags |
|---|---|---|
| test start / end | point | `tfcap`, `tfcap:<test-id>` |
| each stage, measure window | region | `tfcap`, `tfcap:<test-id>`, `tfcap:stage:<label>` |
| knee | point at the knee stage | `tfcap`, `tfcap:<test-id>`, `tfcap:knee` |

[V] The annotation endpoint and payload differ by Grafana version — the current docs describe the
resource-style API (`spec.time`, `spec.time_end`, `spec.tags`), older versions use
`POST /api/annotations`. Confirm which your instance serves and keep the path in one place in
`report.js`. Prefer tag-based display (a dashboard annotation query filtered on `tfcap`) over posting
to specific dashboards, so the markers appear everywhere without the harness knowing your dashboards.

Clock skew is the one subtlety that can quietly corrupt the infra section, since query windows and
annotation times come from the jump-host clock. At the start of a run the wrapper compares Grafana's
`Date` response header with the local clock and records `clock_skew_ms` in `meta.json`; above two
seconds it adds a warning, and stage-level resource numbers should not be trusted when the skew is
larger than the query step.

On failure, each query gets a timeout and one retry; a query that still fails is written to
`infra.json` with its error and the overall `infra.status` becomes `partial`. Nothing on the Grafana
path can change the test's `status` or its exit code.

## Retention

Retention is a property of the results directory, not of any one test, so it has its own file rather
than a scenario field.

| Class | Files | Why | Default |
|---|---|---|---|
| keep | `summary.json`, `report.md`, `infra.json`, `annotations.json`, `meta.json`, `scenario.effective.json`, `cleanup.json`, `manifest.json`, `index.csv` | the decision and its evidence; all small | indefinite |
| medium | `summary-stage-*.json`, `runs.jsonl`, `runs.csv` | enough to recompute statistics | 180 days |
| short | `test.log`, `metrics-stage-*.ndjson` | bulky; only needed to debug the harness | 30 days |

[R] Measure the real sizes in the pilot. The keep and medium classes are kilobytes to a few megabytes
per test. The raw k6 JSON is the large one: k6 emits a point per sample and several points per HTTP
request, so a full multi-hour ladder is on the order of a hundred megabytes before gzip, and roughly a
tenth of that after. Set the short-class cap from the measured figure.

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

Pruning is a separate, explicit step. `tools/prune-results.sh` reads `retention.json`, is a dry run by
default, and only deletes with `--apply`; a test run never deletes older results. It removes files
past their class age first, then, if `max_total_mb` is still exceeded, the oldest short-class files;
keep-class files are never size-pruned. A pinned test is exempt — pin it by setting `"pinned": true`
in its `summary.json` (an empty `PINNED` file in the folder does the same), and pin the run that
established your safe concurrency and the pilot that set the baseline, since later runs are read
against them. When a file is pruned it stays listed in `manifest.json` with the date and reason, and
`index.csv` rows are never removed, so a gap is always explained rather than mysterious. Incomplete,
aborted, and invalid tests age out on the same schedule; they are evidence about how the harness
fails and are not deleted early.

Three things sit outside the folder. Prometheus and Grafana metric retention belong to the platform
team and are not managed here — that is exactly why `infra.json` copies the numbers in immediately; if
the report step could not collect them, re-run it before the platform's retention window closes.
Grafana annotations are small, tagged `tfcap:<test-id>`, and left in place by default
(`delete_annotations_with_results: false`) because they are cheap and explain old dashboards; to erase
a run's markers, `run_test.sh --purge-annotations <test-id>` deletes the ids in `annotations.json`.
TFE's own data is the test's footprint, not its result: `cleanup.js` deletes the workspaces, and
whether that also clears the runs, logs, and state-version rows from Postgres and object storage is
measured in the pilot (design doc §12) and recorded in `cleanup.json`.

[R] Treat the jump host as scratch, not the system of record. After each test, copy the keep class — a
few hundred kilobytes — somewhere the team owns: `run_test.sh --export <test-id>` writes
`<test-id>-keep.tar.gz` for Artifactory or the change record.

Results carry the TFE and Grafana addresses, the organization and workspace names, the Artifactory
URL, and infrastructure metrics. They carry no tokens, because scenarios store env-var names only and
the client never logs the `Authorization` header. Still, treat the folder as internal: create it with
`umask 027` (mode 0750) and keep `results/` out of any shared repository.

## What this changes elsewhere

Design doc §10 and §11 are superseded here: the file layout, the enriched `summary.json`, and the
infra/annotation handling are defined in this document. In the configuration format, the `grafana`
block now points at `infra-queries.json` through `grafana.queries_file` instead of listing metrics
inline, and the scenario no longer carries a `retention` block — retention moved to `retention.json`.
The schema, the validator, and the format document were updated together.

## Not verified

- The exact Grafana annotation endpoint and payload for your version (resource API vs legacy `POST /api/annotations`).
- The Prometheus body fields for `POST /api/ds/query` on your version.
- The service-account permissions needed to query and to create annotations.
- Whether a tag-based dashboard annotation query renders regions as expected.
- The real on-disk size of `test.log` and the raw k6 output for a full ladder.
- Whether your Grafana expires annotations on its own.

## Sources

- [k6 JSON output, gzipped when the filename ends in `.gz`](https://grafana.com/docs/k6/latest/results-output/real-time/json/)
- [Grafana data source query API (`/api/ds/query`)](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/data_source/)
- [Grafana annotations API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/annotations/)
- Earlier k6 and TFE sources are in the design document.
