#!/usr/bin/env bash
# Smoke the globally installed `limn` package against a seeded db: capture one shot.
set -euo pipefail
seed_file="${1:?usage: smoke-installed.sh <seed.json> <out.png>}"
out="${2:?out png}"

limn="$(command -v limn || true)"
if [ -z "$limn" ]; then
  echo "limn is not installed globally (npm i -g @glebmish/limn); nothing to smoke" >&2
  exit 1
fi

DB=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).db)" "$seed_file")
SID=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).sessionId))" "$seed_file")

port="${LIMN_PORT:-$((20000 + RANDOM % 20000))}"
LIMN_DEV_HOOKS=1 LIMN_DB="$DB" LIMN_PORT="$port" "$limn" service serve >/tmp/limn-installed.log 2>&1 &
srv=$!
# The server stops on the first signal (close() calls the live-watch timer down),
# so this is only a safety net for a wedged run — e.g. a headless Chrome holding
# a socket open — not a workaround for a known hang.
kill_srv() {
  kill "$srv" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$srv" 2>/dev/null || return 0; sleep 0.1; done
  kill -9 "$srv" 2>/dev/null || true
}
trap kill_srv EXIT
healthy=0
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$port/health" >/dev/null && { healthy=1; break; }; sleep 0.2; done
[ "$healthy" = 1 ] || { echo "server never became healthy" >&2; exit 1; }

url="$(env LIMN_PORT="$port" LIMN_OPEN_SESSION="$SID" LIMN_FLOW=chat LIMN_SHOW_AFFORDANCES=1 \
  LIMN_FOCUS='{"kind":"diff","file":"src/long.ts","side":"new","line":25}' \
  npx tsx scripts/dev-url.mts)"
npx tsx scripts/cdp-shot.mts --url "$url" --out "$out" --delay 6000
echo "wrote $out"
