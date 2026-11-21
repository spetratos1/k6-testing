#!/usr/bin/env bash
# tools/prune-results.sh — enforce the local results retention policy (docs/RESULTS.md §6.1).
#   1. gzip raw files (test.log, metrics-*.ndjson) once a run is done.
#   2. delete raw files older than KEEP_RAW_DAYS.
#   3. prune oldest test folders beyond MAX_LOCAL_TESTS, keeping a summary.json-only stub.
# Canonical files (summary.json, summary-stage-*, scenario.effective.json, meta.json, infra-*.json)
# are never deleted by this script.
#
# Usage: tools/prune-results.sh [results_dir] [--keep-raw-days N] [--max-local-tests N]
# Safe to run repeatedly (e.g. at the end of run_test.sh or on a cron).

set -euo pipefail

RESULTS_DIR="results"
KEEP_RAW_DAYS=14
MAX_LOCAL_TESTS=50

while [ $# -gt 0 ]; do
  case "$1" in
    --keep-raw-days) KEEP_RAW_DAYS="$2"; shift 2 ;;
    --max-local-tests) MAX_LOCAL_TESTS="$2"; shift 2 ;;
    -* ) echo "unknown option: $1" >&2; exit 2 ;;
    * ) RESULTS_DIR="$1"; shift ;;
  esac
done

[ -d "$RESULTS_DIR" ] || { echo "no results dir: $RESULTS_DIR"; exit 0; }

# 1 + 2) compress raw files, then delete compressed raw older than KEEP_RAW_DAYS.
find "$RESULTS_DIR" -type f \( -name 'test.log' -o -name 'metrics-*.ndjson' \) -print0 \
  | while IFS= read -r -d '' f; do gzip -f "$f"; done
find "$RESULTS_DIR" -type f \( -name 'test.log.gz' -o -name 'metrics-*.ndjson.gz' \) \
  -mtime "+${KEEP_RAW_DAYS}" -delete

# 3) prune oldest test folders beyond MAX_LOCAL_TESTS, keeping a summary stub.
mapfile -t DIRS < <(find "$RESULTS_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr | awk '{print $2}')
count=${#DIRS[@]}
if [ "$count" -gt "$MAX_LOCAL_TESTS" ]; then
  for ((i=MAX_LOCAL_TESTS; i<count; i++)); do
    d="${DIRS[$i]}"
    if [ -f "$d/summary.json" ]; then
      # keep only summary.json as the stub
      find "$d" -mindepth 1 ! -name 'summary.json' -delete
      echo "stubbed (kept summary.json): $d"
    else
      rm -rf "$d"
      echo "removed (no summary): $d"
    fi
  done
fi

echo "prune done: ${RESULTS_DIR} (keep_raw_days=${KEEP_RAW_DAYS}, max_local_tests=${MAX_LOCAL_TESTS})"
