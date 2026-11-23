#!/usr/bin/env bash
# tools/prune-results.sh — enforce the results retention policy (docs/RESULTS.md, Retention).
# A test run never prunes; this is the separate, explicit step. Dry run by default; pass --apply
# to actually compress and delete. Reads classes from config/retention.json. Keep-class files are
# never touched. Pinned tests (a PINNED file, or "pinned": true in summary.json) are skipped.
#
# Usage: tools/prune-results.sh [results_dir] [--retention config/retention.json] [--apply]

set -euo pipefail

RESULTS_DIR="results"
RET_FILE="config/retention.json"
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --retention) RET_FILE="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) RESULTS_DIR="$1"; shift ;;
  esac
done
[ -d "$RESULTS_DIR" ] || { echo "no results dir: $RESULTS_DIR"; exit 0; }

# Read class ages from retention.json without jq (Node is already a harness dependency).
eval "$(node -e '
const fs=require("fs"); let r={};
try { r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); } catch(e){}
const c=r.classes||{};
const m=c.medium&&c.medium.max_age_days, s=c.short&&c.short.max_age_days, mb=c.short&&c.short.max_total_mb;
process.stdout.write(`MEDIUM_DAYS=${m==null?180:m}\nSHORT_DAYS=${s==null?30:s}\nSHORT_MAX_MB=${mb==null?0:mb}\n`);
' "$RET_FILE" 2>/dev/null || true)"
MEDIUM_DAYS="${MEDIUM_DAYS:-180}"; SHORT_DAYS="${SHORT_DAYS:-30}"; SHORT_MAX_MB="${SHORT_MAX_MB:-0}"

ACTION="DRY-RUN"; [ "$APPLY" = 1 ] && ACTION="APPLY"
echo ">> prune ${RESULTS_DIR}: medium>${MEDIUM_DAYS}d, short>${SHORT_DAYS}d, short_cap=${SHORT_MAX_MB}MB [${ACTION}]"

is_pinned() { [ -f "$1/PINNED" ] || grep -qs '"pinned":[[:space:]]*true' "$1/summary.json"; }
del() { if [ "$APPLY" = 1 ]; then rm -f "$1"; echo "   deleted $1"; else echo "   would delete $1"; fi; }

# Compress raw short files first.
mapfile -t RAW < <(find "$RESULTS_DIR" -type f \( -name 'test.log' -o -name 'metrics-stage-*.ndjson' \) 2>/dev/null)
for f in "${RAW[@]:-}"; do
  [ -n "$f" ] || continue
  if [ "$APPLY" = 1 ]; then gzip -f "$f"; echo "   gzipped $f"; else echo "   would gzip $f"; fi
done

# Age-prune medium and short classes per test folder, skipping pinned tests.
mapfile -t DIRS < <(find "$RESULTS_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
for d in "${DIRS[@]:-}"; do
  [ -n "$d" ] || continue
  if is_pinned "$d"; then echo "   pinned, skipped: $d"; continue; fi
  mapfile -t MED < <(find "$d" -type f \( -name 'summary-stage-*.json' -o -name 'runs.jsonl' -o -name 'runs.csv' \) -mtime "+${MEDIUM_DAYS}" 2>/dev/null)
  for f in "${MED[@]:-}"; do [ -n "$f" ] && del "$f"; done
  mapfile -t SH < <(find "$d" -type f \( -name 'test.log.gz' -o -name 'metrics-stage-*.ndjson.gz' \) -mtime "+${SHORT_DAYS}" 2>/dev/null)
  for f in "${SH[@]:-}"; do [ -n "$f" ] && del "$f"; done
done

# Short-class size cap: once past the cap, delete oldest short files first (skip pinned).
if [ "${SHORT_MAX_MB}" -gt 0 ]; then
  mapfile -t SHORTS < <(find "$RESULTS_DIR" -type f \( -name 'test.log.gz' -o -name 'metrics-stage-*.ndjson.gz' \) -printf '%T@\t%s\t%p\n' 2>/dev/null | sort -n)
  total_mb=0
  for line in "${SHORTS[@]:-}"; do [ -n "$line" ] || continue; sz=$(printf '%s' "$line" | cut -f2); total_mb=$(( total_mb + sz / 1048576 )); done
  echo "   short class ~${total_mb}MB (cap ${SHORT_MAX_MB}MB)"
  if [ "$total_mb" -gt "$SHORT_MAX_MB" ]; then
    over=$(( total_mb - SHORT_MAX_MB ))
    for line in "${SHORTS[@]:-}"; do
      [ "$over" -gt 0 ] || break; [ -n "$line" ] || continue
      path=$(printf '%s' "$line" | cut -f3)
      is_pinned "$(dirname "$path")" && continue
      sz=$(printf '%s' "$line" | cut -f2); del "$path"; over=$(( over - sz / 1048576 ))
    done
  fi
fi

echo "prune done (${ACTION}). The report step records pruned files in manifest.json."
