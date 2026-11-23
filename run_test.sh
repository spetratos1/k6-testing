#!/usr/bin/env bash
# run_test.sh — orchestrate a full capacity test:
#   resolve -> startup guard -> fetch+hash workload -> stages -> return-to-baseline
#   -> merge -> cleanup.
#
# Usage:   TFE_TOKEN=xxx ./run_test.sh [config/scenario.example.json]
# Secrets: TFE_TOKEN (required; a token that can force-delete workspaces),
#          ARTIFACTORY_TOKEN (optional).
# TLS:     prefer a real CA — export SSL_CERT_FILE=/path/to/private-ca.pem.
#          Only set tfe.tls_skip_verify in the scenario as a last resort.
# Requires: bash, k6, curl, openssl, sha256sum

set -euo pipefail

TEST_DATA="${1:-config/scenario.example.json}"
TEST_ID="${TEST_ID:-k6cap-$(date +%Y%m%d-%H%M%S)-$(openssl rand -hex 2)}"
RESULTS="results/${TEST_ID}"
LOG="${RESULTS}/test.log"

: "${TFE_TOKEN:?set TFE_TOKEN (needs force-delete permission: org owner, or workspace-admin if the org allows it)}"
[ -f "$TEST_DATA" ] || { echo "no such scenario file: $TEST_DATA" >&2; exit 1; }

mkdir -p "$RESULTS"
export TEST_ID TEST_DATA TFE_TOKEN

# Always attempt cleanup on any exit (success, failure, Ctrl-C).
cleanup() {
  echo ">> cleanup for ${TEST_ID}"
  k6 run cleanup.js -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" >>"$LOG" 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "test_id=${TEST_ID}"
echo "results=${RESULTS}"

# 1) Validate the scenario against the documented format (fail fast, no code changes).
echo ">> validate scenario"
k6 run validate.js -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" >>"$LOG" 2>&1 || {
  echo "ERROR: scenario failed validation — see ${RESULTS}/validation.json" >&2
  grep -o '"errors":\[[^]]*\]' "${RESULTS}/validation.json" 2>/dev/null || true
  exit 1
}

# 2) Resolve scenario JSON into a sourceable env file (no jq).
echo ">> resolve scenario"
k6 run resolve.js -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" >>"$LOG" 2>&1
# shellcheck disable=SC1090
source "${RESULTS}/resolved.env"

# 2) Startup guard: refuse to run if foreign tfcap-* leftovers exist (ALLOW_FOREIGN=1 to override).
echo ">> startup guard"
k6 run cleanup.js -e MODE=guard -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" \
  ${ALLOW_FOREIGN:+-e ALLOW_FOREIGN="$ALLOW_FOREIGN"} >>"$LOG" 2>&1

# 3) Download the workload slug ONCE and record its sha256 for reproducibility.
TARBALL_PATH="${RESULTS}/config.tar.gz"
echo ">> fetch workload: ${TARBALL_URL}"
curl -fsSL ${ARTIFACTORY_TOKEN:+-H "Authorization: Bearer ${ARTIFACTORY_TOKEN}"} \
  -o "$TARBALL_PATH" "$TARBALL_URL"
export TARBALL_PATH
ARTIFACT_SHA="$(sha256sum "$TARBALL_PATH" | awk '{print $1}')"
# If the scenario pins an expected sha256, verify it (reproducibility guard).
if [ -n "${TARBALL_SHA256:-}" ] && [ "${TARBALL_SHA256}" != "${ARTIFACT_SHA}" ]; then
  echo "ERROR: tarball sha256 mismatch: expected ${TARBALL_SHA256}, got ${ARTIFACT_SHA}" >&2
  exit 1
fi
printf '{"test_id":"%s","artifact_url":"%s","artifact_sha256":"%s","host":"%s","started_at":"%s"}\n' \
  "$TEST_ID" "$TARBALL_URL" "$ARTIFACT_SHA" "$(hostname)" "$(date -u +%FT%TZ)" > "${RESULTS}/meta.json"
echo "   sha256=${ARTIFACT_SHA}"

# 4) One k6 run per concurrency stage (closed model: vus = concurrency).
#    After each stage, evaluate the knee; if stop_on_knee is set, halt the ladder
#    once the knee is CONFIRMED (one stage past it).
RAN_LIST=""
EARLY_STOP=0
for C in $CONCURRENCY_LIST; do
  echo ">> stage concurrency=${C} (dwell=${DWELL}, gracefulStop=${GRACEFUL_STOP})"
  k6 run stage.js \
    -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" \
    -e CONCURRENCY="$C" -e DWELL="$DWELL" -e GRACEFUL_STOP="$GRACEFUL_STOP" \
    -e TARBALL_PATH="$TARBALL_PATH" \
    >>"$LOG" 2>&1
  RAN_LIST="${RAN_LIST} ${C}"

  # Per-stage knee evaluation (writes decision.env).
  k6 run evaluate.js \
    -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" \
    -e DONE_LIST="$RAN_LIST" -e WARMUP_STAGE="$WARMUP_STAGE" \
    >>"$LOG" 2>&1
  # shellcheck disable=SC1090
  source "${RESULTS}/decision.env"
  echo "   knee=${KNEE_CONCURRENCY:-none} signal=${KNEE_SIGNAL:-} confirmed=${KNEE_CONFIRMED:-0}"

  if [ "${STOP_ON_KNEE:-0}" = "1" ] && [ "${KNEE_CONFIRMED:-0}" = "1" ]; then
    echo ">> knee confirmed at ${KNEE_CONCURRENCY} (${KNEE_SIGNAL}); stopping ladder early"
    EARLY_STOP=1
    break
  fi
done

# 5) Return-to-baseline stage (drift detection) — labeled so it doesn't collide.
if [ -n "${RETURN_TO_BASELINE:-}" ]; then
  echo ">> return-to-baseline concurrency=${RETURN_TO_BASELINE}"
  k6 run stage.js \
    -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" \
    -e CONCURRENCY="$RETURN_TO_BASELINE" -e STAGE_LABEL="baseline-return" \
    -e DWELL="$DWELL" -e GRACEFUL_STOP="$GRACEFUL_STOP" \
    -e TARBALL_PATH="$TARBALL_PATH" \
    >>"$LOG" 2>&1
fi

# 6) Merge per-stage summaries -> summary.json (+ knee / safe concurrency / drift).
#    Pass only the stages actually run, and flag an early stop for the status field.
echo ">> merge"
k6 run merge.js \
  -e TEST_ID="$TEST_ID" -e TEST_DATA="$TEST_DATA" \
  -e CONCURRENCY_LIST="$RAN_LIST" -e WARMUP_STAGE="$WARMUP_STAGE" \
  -e EARLY_STOP="$EARLY_STOP" \
  >>"$LOG" 2>&1

echo "done -> ${RESULTS}/summary.json"

# A test run never prunes. Retention is a separate, explicit step (docs/RESULTS.md):
#   tools/prune-results.sh results --retention config/retention.json            # dry run
#   tools/prune-results.sh results --retention config/retention.json --apply    # compress + delete
# cleanup runs via the EXIT trap
