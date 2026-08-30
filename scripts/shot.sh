#!/usr/bin/env bash
# Dev screenshot helper: seed a fixture db, serve it on an ephemeral port, capture a
# PNG with headless Chrome, stop. Usage: scripts/shot.sh <out.png> [LIMN_* env ...]
#   scripts/shot.sh /tmp/a.png LIMN_ACTIVE_CHAT=2 LIMN_FOCUS='{"kind":"diff","file":"src/a.ts","side":"new","line":2}'
set -euo pipefail
out="${1:?usage: shot.sh <out.png> [ENV=val ...]}"; shift || true
seed="$(npx tsx scripts/shoot.mts)"
db="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).db)" "$seed")"
sid="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).sessionId))" "$seed")"
echo "seed: $seed" >&2
port="${LIMN_PORT:-$((20000 + RANDOM % 20000))}"
[ -f dist/renderer/index.html ] || npm run build >/dev/null
LIMN_DEV_HOOKS=1 LIMN_DB="$db" LIMN_PORT="$port" node bin/limn.js service serve >/tmp/limn-serve.log 2>&1 &
srv=$!
. "$(dirname "$0")/lib.sh"
trap kill_srv EXIT
wait_healthy
url="$(env LIMN_PORT="$port" LIMN_OPEN_SESSION="$sid" LIMN_FLOW=chat "$@" npx tsx scripts/dev-url.mts)"
npx tsx scripts/cdp-shot.mts --url "$url" --out "$out" --delay "${LIMN_SHOT_DELAY:-6000}"
echo "wrote $out" >&2
