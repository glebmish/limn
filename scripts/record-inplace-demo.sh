#!/usr/bin/env bash
# Record the in-place-edits demo: seed via shoot.mts (caller), serve on an ephemeral
# port, drive LIMN_SCENARIO, capture frames via cdp-shot.mts --frames.
# Usage: record-inplace-demo.sh <seed.json> <framesdir>
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

port="${LIMN_PORT:-$((20000 + RANDOM % 20000))}"
[ -f dist/renderer/index.html ] || npm run build >/dev/null
LIMN_DEV_HOOKS=1 LIMN_DB="$DB" LIMN_PORT="$port" node bin/limn.js service serve >/tmp/limn-serve.log 2>&1 &
srv=$!
. "$(dirname "$0")/lib.sh"
trap kill_srv EXIT
wait_healthy

url="$(env LIMN_PORT="$port" LIMN_OPEN_SESSION="$SID" LIMN_FLOW=chat LIMN_SHOW_AFFORDANCES=1 \
  LIMN_FOCUS='{"kind":"diff","file":"src/long.ts","side":"new","line":25}' \
  LIMN_SCENARIO="$SCENARIO" \
  npx tsx scripts/dev-url.mts)"
npx tsx scripts/cdp-shot.mts --url "$url" --frames "$frames" --every 350 --count 36 --delay 2500

ls "$frames" | wc -l
