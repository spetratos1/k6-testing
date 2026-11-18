#!/usr/bin/env bash
# run_test.sh — orchestrate a full capacity test: resolve -> fetch workload ->
# one k6 run per concurrency stage -> merge -> cleanup.
#
# Usage:   TFE_TOKEN=xxx ./run_test.sh [config/scenario.example.json]
# Secrets: TFE_TOKEN (required), ARTIFACTORY_TOKEN (optional, for Artifactory auth)
# Requires: bash, k6, curl, openssl

set -euo pipefail

TEST_DATA="${1:-config/scenario.example.json}"
TEST_ID="${TEST_ID:-k6cap-$(date +%Y%m%d)-$(openssl rand -hex 3)}"
RESULTS="results/${TEST_ID}"
LOG="${RESULTS}/test.log"

: "${TFE_TOKEN:?set TFE_TOKEN (a TFE API token; admin token enables the observer)}"
[ -f "$TEST_DATA" ] || { echo "no such scenario file: $TEST_DATA" >&2; exit 1; }

mkdir -p "$RESULTS"
export TEST_ID TEST_DATA TFE_TOKEN

# Always attempt cleanup on any exit (success, failure, or Ctrl-C).
cleanup() {
  echo ">> cleanup for ${TEST_ID}"
  k6 run cleanup.js -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" >>"$LOG" 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "test_id=${TEST_ID}"
echo "results=${RESULTS}"

# 1) Resolve scenario JSON into a sourceable env file (no jq needed).
echo ">> resolve scenario"
k6 run resolve.js -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" >>"$LOG" 2>&1
# shellcheck disable=SC1090
source "${RESULTS}/resolved.env"

# 2) Download the workload slug from Artifactory ONCE.
TARBALL_PATH="${RESULTS}/config.tar.gz"
echo ">> fetch workload: ${TARBALL_URL}"
curl -fsSL ${ARTIFACTORY_TOKEN:+-H "Authorization: Bearer ${ARTIFACTORY_TOKEN}"} \
  -o "$TARBALL_PATH" "$TARBALL_URL"
export TARBALL_PATH

# 3) One k6 run per concurrency stage (closed model: vus = concurrency).
for C in $CONCURRENCY_LIST; do
  echo ">> stage concurrency=${C} (dwell=${DWELL}, gracefulStop=${GRACEFUL_STOP})"
  k6 run stage.js \
    -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" \
    -e CONCURRENCY="$C" -e DWELL="$DWELL" -e GRACEFUL_STOP="$GRACEFUL_STOP" \
    -e TARBALL_PATH="$TARBALL_PATH" \
    >>"$LOG" 2>&1
done

# 4) Merge per-stage summaries -> summary.json (+ knee / safe concurrency).
echo ">> merge"
k6 run merge.js \
  -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" \
  -e CONCURRENCY_LIST="$CONCURRENCY_LIST" -e WARMUP_STAGE="$WARMUP_STAGE" \
  >>"$LOG" 2>&1

echo "done -> ${RESULTS}/summary.json"
# cleanup runs via the EXIT trap
