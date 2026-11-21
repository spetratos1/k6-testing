# Test results and retention strategy — design

This document defines what the TFE capacity test **outputs**, **which files it produces**, **how
those results are generated**, and **how long they are kept**. It assumes the harness design
(`tfe-capacity-test-design.md`) and the configuration format (`tfe-test-configuration-format.md`).

**New capability (verified):** the jump host can reach the **Grafana HTTP API** to (1) read any
existing metric and (2) write annotations. This supersedes the earlier "correlate by hand on existing
dashboards" approach (design doc §7/§10): the harness now marks each stage window with a Grafana
annotation and pulls per-window infrastructure metrics into the results, so a result says both
**when** saturation happened and **which resource** saturated — without exposing Prometheus, Grafana,
the nodes, or the Kubernetes API *to* the jump host (the jump host makes authenticated **outbound**
calls to Grafana only).

---

## 1. What the results must answer (outputs)

A finished test answers, for a given workload and `observed_config`:

1. **Headline** — the knee concurrency, the limiting signal, the recommended safe operating
   concurrency, the regime (configuration- vs infrastructure-limited), and now the **first
   bottleneck resource** (derived from the Grafana infra pull).
2. **Per stage** — target concurrency and regime; whether steady state was reached; completion
   throughput; queue depth (avg/max/p95); phase durations (plan-queue, plan, apply-queue, apply, run)
   as p50/p90/p95/max; failure rate; and the **infrastructure stats for that stage's window** (node
   CPU/mem/disk, Postgres, Redis, object storage, agent-pod pending, provider mirror).
3. **Validity** — 429 count (any ⇒ invalid), min-completions-per-stage met, warmup excluded,
   baseline drift (return-to-baseline p95 delta).
4. **Provenance** — `test_id`, effective scenario (+ hash), workload artifact URL + sha256 + run
   variables, TFE version, `observed_config` + ceiling, k6 version, host, wall-clock stage windows,
   and the Grafana annotation IDs + dashboard links so a reader can jump to the live view.

The canonical, machine-readable carrier of all of this is **`summary.json`** (§4). Everything else on
disk is either an input to it, raw detail behind it, or an operational record.

---

## 2. How results are generated (pipeline)

Results are produced by the wrapper + k6 scripts + two optional Grafana steps, in this order. Steps
marked *(Grafana)* run only when `grafana.enabled` is true and the API is reachable; the test still
produces complete non-infra results without them.

```
validate -> resolve -> startup guard -> fetch + sha256 workload (meta.json)
for each stage C in the ladder (+ return-to-baseline):
    (Grafana) POST a region annotation for the stage's MEASURE window
              tags: [tfe-captest, test_id, stage:C, phase:measure]   -> record annotation id
    k6 run stage.js  ->  custom metrics (Counter/Trend/Rate)
                     ->  handleSummary writes summary-stage-<label>.json
                     ->  per-run NDJSON lines to test.log
                     ->  optional raw samples to metrics-stage-<C>.ndjson
    evaluate.js -> decision.env  (knee check; early stop if configured)
(Grafana) for each stage window: query the configured PromQL via the Grafana
          datasource API; reduce each series over the window (max/avg/p95)
          -> results/<id>/infra-<label>.json
merge.js  ->  folds per-stage summaries + infra blocks + drift + knee
          ->  summary.json  (names the first-bottleneck resource)
prune-results.sh (retention)   ;   cleanup.js (workspaces, via trap)
```

Key properties:
- **Server-authoritative timing.** Phase durations come from TFE `status-timestamps`; stage windows
  come from the wrapper's wall clock. Both are written into `summary.json`, and the stage window is
  exactly the span the Grafana annotation and the infra pull use — so the k6-side curves and the
  infra curves line up on the same interval.
- **Degrades cleanly.** No Grafana ⇒ no annotations and no `infra-*.json`; `summary.json` still has
  everything the harness measures directly, and the operator can overlay by timestamp as before.
- **One source of truth per concern.** Per-stage percentiles come only from each stage's
  `handleSummary`; the knee comes only from `lib/knee.js` (shared by `evaluate.js` and `merge.js`);
  infra stats come only from the Grafana pull. Nothing is computed two different ways.

---

## 3. Files produced

All under `results/<test-id>/`. "Tier" drives retention (§6): **canonical** = small, keep long;
**raw** = large, keep short; **operational** = small records.

| File | Tier | Format | Produced by | Purpose |
|---|---|---|---|---|
| `summary.json` | canonical | JSON | `merge.js` | the result: headline, per-stage metrics + infra, validity, provenance |
| `summary-stage-<label>.json` | canonical | JSON | `stage.js` `handleSummary` | one stage's metrics (percentiles from k6) |
| `scenario.effective.json` | canonical | JSON | wrapper | the effective scenario after defaults, for traceability |
| `meta.json` | canonical | JSON | wrapper | artifact URL + sha256, host, k6 version, wall-clock start/end |
| `validation.json` | operational | JSON | `validate.js` | scenario validation result (errors/warnings) |
| `guard.json` | operational | JSON | `cleanup.js` (guard) | foreign-leftover check |
| `cleanup.json` | operational | JSON | `cleanup.js` | workspaces deleted / canceled / orphans |
| `decision.env` | operational | env | `evaluate.js` | last knee decision (early-stop signal) |
| `resolved.env` | operational | env | `resolve.js` | per-stage values the wrapper sourced |
| `grafana-annotations.json` | operational | JSON | Grafana step | annotation IDs created (for retention/cleanup) |
| `infra-<label>.json` | canonical | JSON | Grafana step | reduced infra series per stage window |
| `test.log` | raw | NDJSON | `stage.js` `console.log` | one line per finished run (run_id, ws_id, transitions, timestamps, has-changes) |
| `metrics-stage-<C>.ndjson` | raw | NDJSON | k6 `--out json` (optional) | every metric sample; large — opt in when needed |

Design choices behind the inventory:
- **High-cardinality detail (run/workspace IDs) lives in `test.log`, never in metric tags**, so the
  JSON summaries stay small and low-cardinality.
- **`scenario.effective.json` + `meta.json`** make every result reproducible: you can tie a number to
  the exact config, workload bytes, and environment it came from.
- **Raw k6 output is opt-in** (`metrics-stage-*.ndjson`) because it also contains built-in HTTP
  metrics and is large; the per-stage summaries already carry the percentiles.

---

## 4. `summary.json` — canonical output (enriched)

Extends the schema in design doc §11 with `infra`, `grafana`, and `first_bottleneck_resource`.

```jsonc
{
  "test_id": "k6cap-20261120-2023-ab",
  "schema_version": "2",                 // bumped: adds infra + grafana blocks
  "status": "completed",                 // completed | stopped_knee | partial | aborted | incomplete
  "started_at": "...", "ended_at": "...",
  "tfe": { "address": "...", "organization": "...", "version": "v2.0.7" },
  "observed_config": { "tfe_capacity_concurrency": 20, "terraform_enterprise_replicas": 3, "config_ceiling": 60 },
  "workload": { "config": "state-heavy", "tarball_url": "...", "tarball_sha256": "...",
                "terraform_version": "1.9.8", "run_variables": { "mock_count": "50", "hold_seconds": "30" } },
  "grafana": {                            // present only when enabled
    "base_url": "https://grafana.example.internal",
    "annotation_tags": ["tfe-captest", "k6cap-20261120-2023-ab"],
    "dashboards": ["https://grafana.example.internal/d/tfe-overview"]
  },
  "stages": [{
    "stage_label": "20", "stage_concurrency": 20, "regime": "below_ceiling",
    "window": { "start": "...", "end": "..." },
    "steady_state_reached": true,
    "runs": { "created": 60, "completed": 58, "failed": 2 },
    "throughput_completions_per_min": 3.4,
    "queue_depth": { "avg": 0.6, "max": 4, "p95": 3 },
    "durations_seconds": {
      "plan_queue": { "p50": 1.4, "p90": 3, "p95": 4, "max": 9 },
      "plan": {}, "apply_queue": {}, "apply": {}, "run": { "p50": 72, "p90": 90, "p95": 95, "max": 130 }
    },
    "failures": [{ "reason": "errored", "count": 2 }],
    "infra": {                            // from the Grafana pull for this window
      "postgres_cpu_pct":        { "avg": 61, "max": 78, "p95": 74 },
      "node_cpu_pct":            { "avg": 55, "max": 70, "p95": 68 },
      "agent_pods_pending":      { "avg": 0,  "max": 1,  "p95": 0 },
      "object_store_p99_ms":     { "avg": 40, "max": 120, "p95": 95 },
      "pg_connections":          { "avg": 180, "max": 210, "p95": 205 }
    },
    "annotation_id": 4412
  }],
  "return_to_baseline": { "...": "..." },
  "result": {
    "knee_concurrency": 30,
    "limiting_signal": "p95_run_duration_rise",
    "safe_operating_concurrency": 24,
    "first_bottleneck_resource": "postgres_cpu_pct",   // highest-utilization infra metric at/near the knee
    "baseline_drift": { "concurrency": 10, "pct_change": 6.2 },
    "notes": "Knee below ceiling (60) => infrastructure-limited. Postgres CPU led (p95 74% at c=30)."
  },
  "cleanup": { "workspaces_deleted": 60, "orphans_remaining": 0, "ok": true }
}
```

`first_bottleneck_resource` is picked by `merge.js` from the infra block of the knee stage (and its
neighbour): the metric with the highest utilization against its configured limit. If Grafana is
disabled, the field is `null` and the note says to correlate manually.

---

## 5. Grafana integration

Two independent, read-/annotate-only uses of the Grafana API, authenticated by a token from
`grafana.token_env` (never in the scenario file).

### 5.1 Annotations (mark the stage windows)
For each stage's **measure** window the harness POSTs a region annotation
(`POST /api/annotations` with `time`, `timeEnd`, `tags`, `text`). Tags are
`["tfe-captest", "<test_id>", "stage:<label>", "phase:measure"]`. Effects:
- Every dashboard that shows these tags renders the exact test windows, so a human reviewing live
  dashboards sees precisely when each concurrency stage ran.
- The returned annotation IDs are recorded in `grafana-annotations.json` and per stage in
  `summary.json`, so retention can delete them later by ID or tag.

### 5.2 Metric pull (name the bottleneck)
After each stage, for its window, the harness queries a **configured list of PromQL expressions**
through the Grafana datasource API (`POST /api/ds/query`, or the datasource proxy `query_range`), and
reduces each returned series over the window to `{avg, max, p95}`. Results go into the stage's `infra`
block. The expressions are cluster-specific and live in config (`grafana.metrics`); sensible defaults
map to the design doc's infrastructure signals:

| Key | What it watches | Example PromQL (adapt to your stack) |
|---|---|---|
| `postgres_cpu_pct` | Postgres saturation | `100 * rate(...pg cpu...)` |
| `pg_connections` | connection pressure | `pg_stat_activity_count` |
| `node_cpu_pct` | node contention | `100 - avg by(node)(rate(node_cpu_seconds_total{mode="idle"}[1m]))*100` |
| `node_mem_pct` / `node_disk_p99_ms` | memory / disk latency | stack-specific |
| `agent_pods_pending` | scheduling-bound | `count(kube_pod_status_phase{phase="Pending", namespace="<agents>"})` |
| `tfe_pod_cpu_throttle` | TFE app throttling | `rate(container_cpu_cfs_throttled_periods_total{...}[1m])` |
| `object_store_p99_ms` / `redis_*` | object storage / Redis | stack-specific |
| `mirror_req_rate` | provider mirror / Artifactory | stack-specific |

The pull is the mechanism that turns "something saturated at c=30" into "Postgres CPU led." Because
it uses the **same window** as the stage metrics, the correlation is exact, not eyeballed.

---

## 6. Retention strategy

Three domains retain independently.

### 6.1 Local results (jump host)
Tiered by the inventory in §3, enforced by `tools/prune-results.sh` (run at the end of the wrapper or
on a schedule):
- **canonical** (`summary.json`, `summary-stage-*.json`, `scenario.effective.json`, `meta.json`,
  `infra-*.json`) — kept; these are small. Default: keep all; prune test folders only beyond
  `retention.max_local_tests` (oldest first), and even then keep a `summary.json`-only stub.
- **raw** (`test.log`, `metrics-stage-*.ndjson`) — **gzip after the run** and delete after
  `retention.keep_raw_days` (default 14). These dominate disk.
- **operational** records — kept with the canonical tier (tiny).

### 6.2 Archive (optional, recommended)
When `retention.archive.enabled`, the wrapper uploads the canonical tier (a small tarball per
`test_id`) to Artifactory alongside the workloads, so long-term results survive jump-host rotation and
are retrievable by `test_id`. Raw tiers are **not** archived by default (size). Archiving is a PUT to
Artifactory with `ARTIFACTORY_TOKEN`; it never leaves the air gap.

### 6.3 Grafana annotations
Annotations are tagged with the `test_id`, so they are cheap to keep as a historical record and easy
to remove. Policy via `retention.grafana_annotations`:
- `keep` (default) — leave them; they document when each test ran.
- `delete_after_days:N` — a prune step deletes annotations by tag older than N days
  (`DELETE /api/annotations/:id` for the recorded IDs, or by tag query).

### 6.4 TFE-side
Not "results," but part of the footprint: ephemeral workspaces are force-deleted by `cleanup.js` each
run; **TFE data accumulation** (runs/logs/state/versions in Postgres and object storage that workspace
deletion may not purge) is tracked separately — see design doc §12/§13 (measure growth, prefer a
non-production mirror). The retention strategy for *results* does not attempt to manage TFE's own data.

---

## 7. Configuration surface (added to the format)

Two optional sections, both defaulting to off/safe, added within format version 1 (schema + validator
+ `CONFIG.md` updated together).

```json
"grafana": {
  "enabled": false,
  "base_url": "https://grafana.example.internal",
  "token_env": "GRAFANA_TOKEN",
  "org_id": 1,
  "annotate": true,
  "annotation_tags": ["tfe-captest"],
  "datasource_uid": "prometheus",
  "metrics": [
    { "name": "postgres_cpu_pct", "expr": "<promql>", "stat": "p95" },
    { "name": "agent_pods_pending", "expr": "<promql>", "stat": "max" }
  ],
  "dashboards": ["https://grafana.example.internal/d/tfe-overview"]
},
"retention": {
  "keep_raw_days": 14,
  "max_local_tests": 50,
  "compress_raw": true,
  "archive": { "enabled": false, "artifact_url_base": "https://artifactory.example.internal/tfe-loadtest/results" },
  "grafana_annotations": "keep"
}
```

Validation: both optional; if `grafana.enabled` is true, `base_url` and `token_env` are required and
`metrics[]` entries need `name` + `expr`. `retention.keep_raw_days` ≥ 0, `max_local_tests` ≥ 1,
`grafana_annotations` is `keep` or `delete_after_days:<n>`. Secrets (`GRAFANA_TOKEN`) stay in the
environment, named by `grafana.token_env`.

---

## 8. Assumptions / not verified ([V])

- The Grafana API endpoints (`/api/annotations`, `/api/ds/query`) and the datasource UID are
  reachable from the jump host with the `GRAFANA_TOKEN` scope needed to read metrics and write
  annotations. (Access verified; exact endpoints/scopes to confirm against your Grafana version.)
- The PromQL in `grafana.metrics` is cluster-specific; the defaults above are templates to adapt.
- Annotation region support (`timeEnd`) and tag-based deletion on your Grafana version.
- `first_bottleneck_resource` is a heuristic (highest utilization vs configured limit at the knee); it
  flags the lead suspect, not a proof — the per-stage `infra` block and the dashboards remain the
  evidence.
