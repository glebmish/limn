#!/usr/bin/env bash
# Dev screenshot helper: seed a fixture db, launch Electron pointed at it, capture
# a PNG, quit. Usage: scripts/shot.sh <out.png> [extra LR_* env assignments...]
#   scripts/shot.sh /tmp/a.png LR_ACTIVE_CHAT=2 LR_FOCUS='{"kind":"diff","file":"src/a.ts","side":"new","line":2}'
set -euo pipefail
out="${1:?usage: shot.sh <out.png> [ENV=val ...]}"; shift || true

seed="$(npx tsx scripts/shoot.mts)"
repo="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).repo)" "$seed")"
db="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).db)" "$seed")"
sid="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).sessionId))" "$seed")"
echo "seed: $seed" >&2

env LR_DB="$db" LR_OPEN_SESSION="$sid" LR_FLOW=chat \
    LR_SHOT="$out" LR_SHOT_DELAY="${LR_SHOT_DELAY:-6000}" LR_SHOT_QUIT=1 \
    "$@" \
    npx electron . >/tmp/lr-electron.log 2>&1 || { echo "electron failed; log:" >&2; tail -40 /tmp/lr-electron.log >&2; exit 1; }
echo "wrote $out" >&2
