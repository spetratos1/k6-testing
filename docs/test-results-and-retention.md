# Test results and retention strategy

Version 2 (simplified). Extends section 7 of `tfe-capacity-test-design-v2.md`; where they differ, this document wins. Tags: **[F]** documented fact, **[R]** recommendation, **[V]** to verify in the pilot.

**In short:** every test produces one folder with **three files**: `summary.json` (the result), `runs.csv` (one row per run) and `test.log`. Grafana is used after the test to copy infrastructure metrics into `summary.json` and to mark the stages on the dashboards. Retention is manual.

## 1. Using the Grafana API to read a metric from a dashboard

This is what the harness does after a test, and what you can do by hand to try it first. Grafana keeps metrics for 12 hours here, so the harness reads them right after the test and stores the numbers in `summary.json`.

**Step 1: create a service account and a token** (once, by a Grafana admin) **[F]**

1. Grafana UI: **Administration > Users and access > Service accounts > Add service account**. Give it a name such as `tfcap-test`, choose its role, click **Create**.
2. Open the account, click **Add service account token**, enter a name, set an expiry date (recommended; without one the token never expires), click **Generate token**.
3. Copy the token immediately. The documentation does not say whether it is shown again, so assume it is not **[V]**.

Role: running queries needs permission to query the data source; creating annotations needs permission to create annotations. A read-only role is usually enough for queries and an editor-level role for annotations **[V]**; the role names depend on your Grafana version and RBAC set-up.

**Step 2: give the token to the test, never to a file**

```bash
export GRAFANA_TOKEN='glsa_...'          # the scenario file stores only the variable NAME
```

Every call sends it as a header **[F]**:

```
Authorization: Bearer <SERVICE_ACCOUNT_TOKEN>
```

**Step 3: find the query behind the dashboard panel you want**

The simplest way is the UI: open the dashboard, open the panel menu, **Inspect > Query** (or **Inspect > Panel JSON**), and copy two things: the **expression** (`expr`) and the **data source UID**.

Two things to fix in the copied expression **[R]**:

- Dashboard variables such as `$namespace` or `$pod` are filled in by the browser, not by the server. Replace them with real values or a regex (`.*`).
- Prometheus macros such as `$__rate_interval` are safest replaced with a fixed value (`2m`).

The expression should return **one series**: wrap it in `max(...)` or `sum(...)`. If it returns several, the harness takes the maximum at each timestamp.

Alternatively the dashboard JSON can be read through the API. It contains the panels, their data source and their queries, but it does **not** return any data **[F]**. The endpoint depends on the Grafana version: newer versions serve `GET /apis/dashboard.grafana.app/v1/namespaces/{namespace}/dashboards/{uid}` with the panels under `spec.panels[].targets[]`; older ones use `GET /api/dashboards/uid/{uid}` **[V]**. The UI route avoids the question.

**Step 4: query the metric** **[F]** endpoint and body shape; **[V]** Prometheus fields (`expr`, `range`)

```bash
FROM=$(date -d '30 minutes ago' +%s%3N); TO=$(date +%s%3N)     # epoch milliseconds

curl -sS -X POST "https://grafana.example.internal/api/ds/query" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" -H 'Content-Type: application/json' \
  -d '{
        "from": "'$FROM'", "to": "'$TO'",
        "queries": [{
          "refId": "A",
          "datasource": { "uid": "prom-main" },
          "expr": "max(sum by (pod) (rate(container_cpu_usage_seconds_total{namespace=\"tfe\",pod=~\"terraform-enterprise-.*\"}[2m])))",
          "range": true, "intervalMs": 15000, "maxDataPoints": 1000
        }]
      }'
```

The response holds `results.<refId>.frames[]`; each frame has a `schema` and `data.values`, which is two arrays, timestamps and values **[F]**:

```json
{ "results": { "A": { "frames": [ { "data": { "values": [
    [1763906700000, 1763906715000, 1763906730000],
    [0.91, 0.94, 0.97]
] } } ] } } }
```

To get the maximum over the window: `... | jq '.results.A.frames[0].data.values[1] | max'`.

**Step 5: mark the test on the dashboards (annotation)**

```bash
curl -sS -X POST "https://grafana.example.internal/api/annotations" \
  -H "Authorization: Bearer $GRAFANA_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "time": 1763906700000, "timeEnd": 1763907600000,
        "tags": ["tfcap", "tfcap:20261123-140500-a3f9", "tfcap:stage:c25"],
        "text": "tfcap 20261123-140500-a3f9: stage c25, N=25" }'
```

This is the long-standing annotations endpoint. The current Grafana documentation describes a newer resource-style API (`spec.time`, `spec.timeEnd`, `spec.tags`, `spec.text`, in Unix milliseconds, created with a `POST` to `/apis/annotation.grafana.app/v0alpha1/namespaces/{namespace}/annotations`) **[F]**. Use whichever your Grafana serves **[V]**; the harness keeps the path in one place. Annotations show on a dashboard if it has an annotation query filtered by the tag `tfcap` **[V]**.

**Step 6: how the harness uses this.** You list the queries once in `config/infra-queries.json` (id, resource, `expr`, optional `breachAbove`). After the test the harness runs each query for each stage's measured window and stores `avg`, `p95`, `max` per stage in `summary.json`. If Grafana is unreachable or the token is missing, the result is still written and says `infra.status: "unavailable"`.

## 2. What the results contain

`summary.json` answers five questions:

| Question | Field |
|---|---|
| Can I trust it? | `status`, `warnings`, per stage `valid`, `infra.status`, `cleanup.result` |
| Where is the knee? | `analysis.kneeStage`, `firstBreached`, `confirmedBy` |
| What concurrency is safe? | `analysis.recommendedSafeConcurrency`, `headroom`, `confidence` |
| When does queueing start? | per stage `durationsSec.planQueue`, `applyQueue`, criterion `S1` |
| What saturates first? | `infra.firstBottleneck`, `infra.perStage` |

Rules: percentiles always carry `n`; a stage with too few runs is marked invalid, not hidden; timed-out runs are counted but kept out of duration percentiles; warmup is excluded; no `p99` below 100 samples. `firstBottleneck` is a pointer for the operator (the first resource over its `breachAbove` at or before the knee), not proof. S5 (waiting runs) is reported as `observed.waitingAvg` for diagnosis but does not set the knee, since some waiting exists even at N=1; the knee uses S1 to S4 as in design section 5.

## 3. Files

```
results/<test-id>/
  summary.json    the result: analysis, per-stage statistics, infrastructure numbers, cleanup, effective config
  runs.csv        one row per run (for spreadsheets, recomputing, debugging)
  test.log        k6 log output (raw per-run lines, errors)
```

That is all. The test ID is `YYYYMMDD-HHMMSS-<4hex>` in UTC.

| File | Written by | How |
|---|---|---|
| `test.log` | k6 | `--log-output=file=test.log --log-format raw`. Each finished run writes one `TFERUN,...` line (CSV fields); setup writes `TFESETUP_DONE,<epoch-ms>`, the exact start of the stages |
| `summary.json` (first version) | `main.js` `handleSummary` | statistics and S1-S4, knee, safe concurrency, stage offsets. Written even if a threshold aborted the test **[F]** |
| `runs.csv` | `run.sh` | header plus `grep '^TFERUN,' test.log \| cut -d, -f2-` |
| `summary.json` (final) | `postprocess.js` | adds absolute stage times, `infra`, `grafana`, `cleanup`, `harness` |

Per-run columns: `stage, phase, vu, iter, workspace, runId, outcome, createdAt, pendingSec, planQueueSec, planSec, applyQueueSec, applySec, runSec, timedOut, forceDeleted, hasChanges`.

## 4. How the results are generated

```
run.sh
 1  create results/<test-id>/, start:
      k6 run main.js --log-output=file=test.log --log-format raw      -> summary.json (stats, knee)
 2  always, even after failure or kill:  k6 run postprocess.js
      a  sweep leftover workspaces by name prefix (same code as cleanup.js)
      b  read test.log (start time) and summary.json (stage offsets)
      c  Grafana: run the infra queries per stage window, post stage annotations
      d  write the final summary.json
 3  runs.csv from test.log
```

- **One post-test script instead of several files.** Cleanup, Grafana and the merge happen in `postprocess.js`; nothing is passed between steps through extra files. `run.sh` passes the k6 exit code and wall-clock start and end as `-e` values.
- **Failure behaviour.** If `postprocess.js` fails, `summary.json` from step 1 is still a valid result (offsets instead of absolute times, no `infra`). If k6 was killed before writing it, `postprocess.js` writes a minimal `status: "incomplete"` summary from the run lines in `test.log`.
- **Grafana never affects the test.** It is called only in step 2c, after the load has stopped.
- **Time.** Stage windows are the `TFESETUP_DONE` time plus the stage offsets **[V]** (check the error is about 1 s in the pilot). Query windows use the jump host clock; `postprocess.js` compares it with the `Date` header of a Grafana response and adds a warning if they differ by more than 2 s.
- **12-hour limit.** Grafana holds 12 hours of metrics, and no test runs that long. The config validator warns when a scenario plus drain time leaves less than an hour of margin, because the queries run after the test.

## 5. Complete example

The example below is **synthetic**: the numbers are invented to be internally consistent (Little's law holds within 8% at every stage; throughput, efficiency and the signals are computed from the counts). They are not measurements of any TFE. The complete files are in `examples/results/20261123-140500-a3f9/`.

**What the operator sees in the terminal** (printed by `handleSummary`):

```
TFE capacity test 20261123-140500-a3f9   status: completed   scenario: tfe-capacity-ladder
stage       N  runs runs/min   eff queue p50  run p50  run p95   fail  signals
baseline    1    30     1.00  1.00      1.6s     56.0     59.0   0.0%  -
c10        10   144     9.60  0.96      1.9s     58.0     64.0   0.0%  -
c20        20   263    17.53  0.88      3.4s     62.0     72.0   0.0%  -
c25        25   263    17.53  0.70     14.5s     78.0     96.0   0.0%  S2,S3
c30        30   258    17.20  0.57     27.0s     96.0    128.0   1.6%  S2,S3,S4
Knee: c25 (S2, S3; confirmed by c30)   Safe concurrency: 20 (low confidence, 1 repeat)
First bottleneck: postgres pg_conn_ratio 0.88 > 0.85 at c25
Infra: ok   Cleanup: clean (1085/1085 workspaces deleted)   Warnings: 2 (see summary.json)
```

**`runs.csv`** (an 11-row excerpt; a real file has one row per run, about 1,100 for this scenario):

```
stage,phase,vu,iter,workspace,runId,outcome,createdAt,pendingSec,planQueueSec,planSec,applyQueueSec,applySec,runSec,timedOut,forceDeleted,hasChanges
baseline,measure,1,4,tfcap-20261123140500a3f9-v1-i4,run-81e74ef5Aq9,applied,2026-11-23T14:07:34Z,0.3,1.5,14.5,1.3,39.5,57.6,false,false,true
baseline,measure,1,5,tfcap-20261123140500a3f9-v1-i5,run-f29d0da9Aq9,applied,2026-11-23T14:08:35Z,0.3,1.6,12.9,1.3,38.7,55.2,false,false,true
c10,measure,3,2,tfcap-20261123140500a3f9-v3-i2,run-4a23d596Aq9,applied,2026-11-23T14:40:42Z,0.3,1.9,16.1,1.5,43.1,63.3,false,false,true
c10,measure,7,3,tfcap-20261123140500a3f9-v7-i3,run-a38fd547Aq9,applied,2026-11-23T14:41:53Z,0.3,1.8,14.1,1.7,37.8,56.1,false,false,true
c20,measure,12,4,tfcap-20261123140500a3f9-v12-i4,run-506bf2efAq9,applied,2026-11-23T15:01:33Z,0.4,3.5,14.2,2.1,38.8,59.4,false,false,true
c20,measure,5,6,tfcap-20261123140500a3f9-v5-i6,run-3e7d1bfbAq9,applied,2026-11-23T15:02:52Z,0.4,3.4,14.9,2.4,42.8,64.3,false,false,true
c25,measure,18,3,tfcap-20261123140500a3f9-v18-i3,run-faecbd38Aq9,applied,2026-11-23T15:18:32Z,0.5,14.9,18.6,4.8,40.6,79.8,false,false,true
c25,measure,9,5,tfcap-20261123140500a3f9-v9-i5,run-ab1031d0Aq9,applied,2026-11-23T15:22:07Z,0.5,14.6,18.2,4.3,42.2,80.2,false,false,true
c30,measure,22,2,tfcap-20261123140500a3f9-v22-i2,run-98289fcdAq9,applied,2026-11-23T15:38:02Z,0.6,27.9,20.6,6.3,45.8,101.6,false,false,true
c30,measure,14,4,tfcap-20261123140500a3f9-v14-i4,run-f1d69ed6Aq9,errored,2026-11-23T15:40:17Z,0.6,27.3,20.5,,,48.8,false,false,true
c30,measure,28,3,tfcap-20261123140500a3f9-v28-i3,run-d269a9a5Aq9,applied,2026-11-23T15:41:32Z,0.6,28.4,17.5,6.8,45.3,99.1,false,false,true
```

**`summary.json`**: key order is the reading order. The `stages` array has five entries (`baseline`, `c10`, `c20`, `c25`, `c30`) of the same shape; only `c25` is shown here. `config` is the scenario file as it ran (after defaults), shown in the example folder.

```jsonc
{
  "schemaVersion": 1,
  "testId": "20261123-140500-a3f9",
  "status": "completed",
  "stop": {
    "reason": "all_stages_complete",
    "detail": null
  },
  "warnings": [
    "Single ladder repeat: treat the knee as a hypothesis. Repeat 2-3 times at different hours.",
    "No return-to-baseline run in this invocation (run it separately, design section 5)."
  ],
  "analysis": {
    "baselineStage": "baseline",
    "kneeStage": "c25",
    "kneeConcurrency": 25,
    "firstBreached": [
      {
        "stage": "c25",
        "signals": [
          "S2",
          "S3"
        ]
      }
    ],
    "confirmedBy": "c30",
    "recommendedSafeConcurrency": 20,
    "headroom": {
      "resource": "postgres",
      "stage": "c20",
      "value": 0.58,
      "threshold": 0.85,
      "headroomPct": 31.8
    },
    "confidence": "low",
    "repeats": 1,
    "method": "highest ladder stage below the knee where S1-S4 all pass and the first-bottleneck resource is at least 25% below its threshold"
  },
  "stages": [
    // baseline, c10, c20, c30: same shape as this entry
    {
      "index": 3,
      "name": "c25",
      "role": "ladder",
      "targetConcurrency": 25,
      "window": {
        "start": "2026-11-23T15:13:02Z",
        "measureStart": "2026-11-23T15:17:02Z",
        "end": "2026-11-23T15:32:02Z",
        "startOffsetSec": 4080,
        "measureStartOffsetSec": 4320,
        "endOffsetSec": 5220
      },
      "valid": true,
      "invalidReason": null,
      "runs": {
        "created": 299,
        "measured": 263,
        "applied": 263,
        "errored": 0,
        "timedOut": 0,
        "canceled": 0,
        "noChanges": 0
      },
      "throughputPerMin": 17.53,
      "throughputEfficiency": 0.7,
      "observed": {
        "waitingAvg": 5.83,
        "executingAvg": 17.95
      },
      "durationsSec": {
        "pending": {
          "n": 263,
          "p50": 0.5,
          "p90": 0.8,
          "p95": 1.0,
          "max": 1.5
        },
        "planQueue": {
          "n": 263,
          "p50": 14.5,
          "p90": 16.7,
          "p95": 17.8,
          "max": 21.9
        },
        "plan": {
          "n": 263,
          "p50": 17.0,
          "p90": 18.0,
          "p95": 18.7,
          "max": 22.1
        },
        "applyQueue": {
          "n": 263,
          "p50": 4.5,
          "p90": 5.2,
          "p95": 5.5,
          "max": 6.8
        },
        "apply": {
          "n": 263,
          "p50": 41.5,
          "p90": 44.0,
          "p95": 45.7,
          "max": 54.0
        },
        "run": {
          "n": 263,
          "p50": 78,
          "p90": 90.0,
          "p95": 96.0,
          "max": 118.0
        }
      },
      "workspaceOpsSec": {
        "create": {
          "n": 299,
          "p50": 1.2,
          "p95": 2.1,
          "max": 3.4
        },
        "delete": {
          "n": 299,
          "p50": 1.4,
          "p95": 2.6,
          "max": 4.8
        }
      },
      "api": {
        "requests": 8813,
        "status429": 0,
        "status5xx": 1
      },
      "criteria": {
        "S1": {
          "name": "median plan queue wait (s)",
          "value": 14.5,
          "threshold": 30,
          "breached": false
        },
        "S2": {
          "name": "p95 run duration vs baseline",
          "value": 1.63,
          "threshold": 1.5,
          "breached": true
        },
        "S3": {
          "name": "throughput efficiency",
          "value": 0.7,
          "threshold": 0.8,
          "breached": true
        },
        "S4": {
          "name": "failure rate",
          "value": 0.0,
          "threshold": 0.01,
          "breached": false
        }
      }
    }
  ],
  "infra": {
    "status": "ok",
    "reason": null,
    "source": {
      "grafana": "https://grafana.example.internal",
      "datasourceUid": "prom-main"
    },
    "queries": [
      {
        "id": "tfe_pod_cpu",
        "resource": "cpu",
        "title": "TFE pods CPU (cores, max pod)",
        "unit": "cores",
        "breachAbove": 6.0
      },
      {
        "id": "tfe_pod_mem",
        "resource": "memory",
        "title": "TFE pods memory / limit (max pod)",
        "unit": "ratio",
        "breachAbove": 0.85
      },
      {
        "id": "pg_conn_ratio",
        "resource": "postgres",
        "title": "Postgres connections / max",
        "unit": "ratio",
        "breachAbove": 0.85
      },
      {
        "id": "redis_cpu",
        "resource": "redis",
        "title": "Redis CPU (cores)",
        "unit": "cores",
        "breachAbove": null
      },
      {
        "id": "minio_latency_p95",
        "resource": "minio",
        "title": "MinIO request latency p95 (s)",
        "unit": "seconds",
        "breachAbove": 1.0
      }
    ],
    "perStage": [
      {
        "stage": "baseline",
        "tfe_pod_cpu": {
          "avg": 0.648,
          "p95": 0.837,
          "max": 0.9,
          "n": 120
        },
        "tfe_pod_mem": {
          "avg": 0.295,
          "p95": 0.381,
          "max": 0.41,
          "n": 120
        },
        "pg_conn_ratio": {
          "avg": 0.086,
          "p95": 0.112,
          "max": 0.12,
          "n": 120
        },
        "redis_cpu": {
          "avg": 0.036,
          "p95": 0.047,
          "max": 0.05,
          "n": 120
        },
        "minio_latency_p95": {
          "avg": 0.043,
          "p95": 0.056,
          "max": 0.06,
          "n": 120
        }
      },
      {
        "stage": "c10",
        "tfe_pod_cpu": {
          "avg": 1.728,
          "p95": 2.232,
          "max": 2.4,
          "n": 60
        },
        "tfe_pod_mem": {
          "avg": 0.338,
          "p95": 0.437,
          "max": 0.47,
          "n": 60
        },
        "pg_conn_ratio": {
          "avg": 0.223,
          "p95": 0.288,
          "max": 0.31,
          "n": 60
        },
        "redis_cpu": {
          "avg": 0.079,
          "p95": 0.102,
          "max": 0.11,
          "n": 60
        },
        "minio_latency_p95": {
          "avg": 0.065,
          "p95": 0.084,
          "max": 0.09,
          "n": 60
        }
      },
      {
        "stage": "c20",
        "tfe_pod_cpu": {
          "avg": 2.808,
          "p95": 3.627,
          "max": 3.9,
          "n": 60
        },
        "tfe_pod_mem": {
          "avg": 0.374,
          "p95": 0.484,
          "max": 0.52,
          "n": 60
        },
        "pg_conn_ratio": {
          "avg": 0.418,
          "p95": 0.539,
          "max": 0.58,
          "n": 60
        },
        "redis_cpu": {
          "avg": 0.137,
          "p95": 0.177,
          "max": 0.19,
          "n": 60
        },
        "minio_latency_p95": {
          "avg": 0.108,
          "p95": 0.14,
          "max": 0.15,
          "n": 60
        }
      },
      {
        "stage": "c25",
        "tfe_pod_cpu": {
          "avg": 3.312,
          "p95": 4.278,
          "max": 4.6,
          "n": 60
        },
        "tfe_pod_mem": {
          "avg": 0.396,
          "p95": 0.512,
          "max": 0.55,
          "n": 60
        },
        "pg_conn_ratio": {
          "avg": 0.634,
          "p95": 0.818,
          "max": 0.88,
          "n": 60
        },
        "redis_cpu": {
          "avg": 0.187,
          "p95": 0.242,
          "max": 0.26,
          "n": 60
        },
        "minio_latency_p95": {
          "avg": 0.245,
          "p95": 0.316,
          "max": 0.34,
          "n": 60
        }
      },
      {
        "stage": "c30",
        "tfe_pod_cpu": {
          "avg": 3.672,
          "p95": 4.743,
          "max": 5.1,
          "n": 60
        },
        "tfe_pod_mem": {
          "avg": 0.418,
          "p95": 0.539,
          "max": 0.58,
          "n": 60
        },
        "pg_conn_ratio": {
          "avg": 0.698,
          "p95": 0.902,
          "max": 0.97,
          "n": 60
        },
        "redis_cpu": {
          "avg": 0.223,
          "p95": 0.288,
          "max": 0.31,
          "n": 60
        },
        "minio_latency_p95": {
          "avg": 0.446,
          "p95": 0.577,
          "max": 0.62,
          "n": 60
        }
      }
    ],
    "firstBottleneck": {
      "resource": "postgres",
      "query": "pg_conn_ratio",
      "stage": "c25",
      "value": 0.88,
      "threshold": 0.85
    }
  },
  "cleanup": {
    "workspacesCreated": 1085,
    "workspacesDeleted": 1085,
    "forceDeleted": 0,
    "leftover": 0,
    "result": "clean"
  },
  "grafana": {
    "annotations": {
      "status": "ok",
      "ids": [
        8841,
        8842,
        8843,
        8844,
        8845,
        8846
      ]
    }
  },
  "tfe": {
    "address": "https://tfe.example.internal",
    "version": "2.0.7",
    "organization": "existing-org",
    "apiRateLimit": 30
  },
  "workload": {
    "profile": "hold-30s",
    "artifactUrl": "https://artifactory.example.internal/artifactory/tfcap/tfcap-hold-30s-v1.tar.gz",
    "artifactSha256": "9f2c41d0b7a85e63c1f04a2d7be9e8153a6c0d94f7b2e1a8c35d60f9ab714e2c",
    "terraformVersion": "1.9.8",
    "reuseWs": false
  },
  "harness": {
    "k6Version": "1.4.0",
    "host": "jump01",
    "k6ExitCode": 0,
    "startedAt": "2026-11-23T14:05:02Z",
    "endedAt": "2026-11-23T15:53:22Z",
    "scenarioDurationSec": 6360,
    "clockSkewMs": 120
  },
  "config": { /* the scenario file as it ran, defaults applied: see examples/results/20261123-140500-a3f9/summary.json */ }
}
```

How to read it: the per-run time grows from 56 s at N=1 to 62 s at N=20, then to 78 s at N=25, while throughput stays at about 17.5 runs/min. More slots no longer produce more runs, the classic knee. Postgres connections cross their 0.85 threshold in the same stage (0.88), while CPU, memory and MinIO stay below theirs. The recommendation is 20, the highest stage below the knee where all signals pass and Postgres still has 32% headroom. Confidence is low because there is one repeat.

## 6. Retention (manual)

Nothing is deleted automatically and there is no retention tooling.

- A test is a folder of three files: `summary.json` and `runs.csv` are small (tens of KB to a few hundred KB); `test.log` is the largest, in the order of MB **[V]**. Delete a folder to remove a test.
- Keep the folders of the tests you rely on: the run that set the baseline and the run behind the recommended concurrency. Compare tests by opening their `summary.json`.
- Copy a finished folder to a team-owned location; the jump host is not a safe place for the only copy.
- Grafana annotations stay in Grafana. Delete them in Grafana (by tag `tfcap:<test-id>`) if you want them gone; the ids are in `summary.json` under `grafana.annotations.ids`.
- Results contain addresses, organization and workspace names, but no tokens (scenario files store variable names only; the client never logs the `Authorization` header). Treat the folder as internal and do not commit it to a shared repository.
- If you ever need the raw k6 metric points for debugging k6 itself, add `--out json=metrics.json.gz` to the k6 command by hand **[F]** (k6 gzips the output when the name ends in `.gz`). It is not part of the standard output.

## 7. What was removed from the previous version

| Removed | Why |
|---|---|
| `report.md` | the terminal table and `summary.json` carry the same information |
| `index.csv`, `manifest.json` | comparison is manual for now; no pruning means no manifest is needed |
| `meta.json`, `cleanup.json`, `scenario.effective.json`, `annotations.json` | their content moved into blocks of `summary.json` (`harness`, `cleanup`, `config`, `grafana`) |
| `analysis.json` | `summary.json` is written in two steps instead |
| `metrics.json.gz` as a default | `runs.csv` has what the analysis needs; raw points are an optional debugging flag |
| Retention classes, `retention.json`, `--prune`, `--export`, `--purge-annotations`, pinning | retention is manual |
| Re-run of post-processing before metrics expire | metrics live 12 hours; post-processing runs right after the test |
| Per-series infra statistics, pre-stage reference windows | queries return one series; one number set per stage is enough |
| `dashboardUid` and `stepSec` in the scenario | tag-based annotations work on any dashboard; the query step is fixed at 15 s |
| Test start/end and warmup-region annotations | one region per stage plus the knee marker is enough |

## 8. Not verified

- Which annotations endpoint your Grafana serves (the long-standing `/api/annotations` or the newer resource API), and the permission the token needs.
- The Prometheus fields of `POST /api/ds/query` (`expr`, `range`) on your Grafana version, and that dashboard-variable expressions work once variables are replaced.
- How the dashboard JSON is served on your version (only needed if you use the API route).
- Whether the service account token is shown only once.
- The `TFESETUP_DONE` offset (about 1 s), and `open()` of absolute paths in k6 init for `postprocess.js`.
- The real size of `test.log` for a full ladder.
- Whether a dashboard annotation query by tag displays the stage regions as expected.

## Sources

- [Grafana HTTP API authentication (service account token, `Authorization: Bearer`)](https://grafana.com/docs/grafana/v13.3/developer-resources/api-reference/http-api/authentication/)
- [Grafana service accounts (UI steps, token expiry)](https://archive.grafana.com/docs/grafana/v11.2/administration/service-accounts/)
- [Grafana data source HTTP API (`/api/ds/query`)](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/api-legacy/data_source.md)
- [Grafana dashboard HTTP API (panels and targets in the response; no query results)](https://grafana.com/docs/grafana/v13.3/developer-resources/api-reference/http-api/dashboard.md)
- [Grafana annotations HTTP API](https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/annotations/)
- [k6 JSON output (gzip with a `.gz` file name)](https://grafana.com/docs/k6/latest/results-output/real-time/json/)
- k6 and TFE sources: see the design document.
