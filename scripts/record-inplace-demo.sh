#!/usr/bin/env bash
# Record the in-place-edits demo: seed via shoot.mts (caller), drive LIMN_SCENARIO,
# capture frames via LIMN_SHOT_FRAMES. Usage: record-inplace-demo.sh <seed.json> <framesdir>
set -euo pipefail
seed_file="${1:?usage: record-inplace-demo.sh <seed.json> <framesdir>}"
frames="${2:?frames dir}"

DB=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).db)" "$seed_file")
SID=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).sessionId))" "$seed_file")
rm -rf "$frames" && mkdir -p "$frames"

SCENARIO='[
 {"at":2600,"do":"dblclick","sel":"[data-limn-line=\"src/long.ts:new:25\"]"},
 {"at":4000,"do":"type","sel":"textarea.ff-ta","text":"export const v25 = 25 * FACTOR // tweaked in review"},
 {"at":5400,"do":"key","sel":"textarea.ff-ta","key":"Enter"},
 {"at":6800,"do":"key","key":"ArrowUp"},
 {"at":7400,"do":"key","key":"ArrowUp"},
 {"at":8000,"do":"key","key":"ArrowUp"},
 {"at":9000,"do":"key","key":"Enter"},
 {"at":10600,"do":"key","sel":"textarea.ff-ta","key":"ArrowUp"},
 {"at":12200,"do":"key","sel":"textarea.ff-ta","key":"Escape"}
]'

env LIMN_DB="$DB" LIMN_OPEN_SESSION="$SID" LIMN_FLOW=chat \
  LIMN_SHOT_FRAMES="$frames" LIMN_SHOT_EVERY=350 LIMN_SHOT_COUNT=36 LIMN_SHOT_DELAY=2500 LIMN_SHOT_QUIT=1 \
  LIMN_SHOW_AFFORDANCES=1 \
  LIMN_FOCUS='{"kind":"diff","file":"src/long.ts","side":"new","line":25}' \
  LIMN_SCENARIO="$SCENARIO" \
  npx electron . >/tmp/limn-electron.log 2>&1

ls "$frames" | wc -l
