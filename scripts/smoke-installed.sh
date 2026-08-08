#!/usr/bin/env bash
# Smoke the INSTALLED /Applications/Limn.app against a seeded db: capture one shot.
set -euo pipefail
seed_file="${1:?usage: smoke-installed.sh <seed.json> <out.png>}"
out="${2:?out png}"
DB=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).db)" "$seed_file")
SID=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).sessionId))" "$seed_file")
env LIMN_DB="$DB" LIMN_OPEN_SESSION="$SID" LIMN_SHOW_AFFORDANCES=1 \
  LIMN_FOCUS='{"kind":"diff","file":"src/long.ts","side":"new","line":25}' \
  LIMN_SHOT="$out" LIMN_SHOT_DELAY=6000 LIMN_SHOT_QUIT=1 \
  /Applications/Limn.app/Contents/MacOS/Limn >/tmp/limn-installed.log 2>&1
echo "wrote $out"
