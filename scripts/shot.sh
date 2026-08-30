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
LIMN_DB="$db" LIMN_PORT="$port" node bin/limn.js service serve >/tmp/limn-serve.log 2>&1 &
srv=$!
# A session with an active live-watch timer can outlive a graceful SIGTERM's
# server.close() (the poll interval keeps the event loop alive), so escalate
# to SIGKILL if it doesn't exit promptly.
kill_srv() {
  kill "$srv" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$srv" 2>/dev/null || return 0; sleep 0.1; done
  kill -9 "$srv" 2>/dev/null || true
}
trap kill_srv EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && break; sleep 0.2; done
url="$(env LIMN_PORT="$port" LIMN_OPEN_SESSION="$sid" LIMN_FLOW=chat "$@" npx tsx scripts/dev-url.mts)"
npx tsx scripts/cdp-shot.mts --url "$url" --out "$out" --delay "${LIMN_SHOT_DELAY:-6000}"
echo "wrote $out" >&2
