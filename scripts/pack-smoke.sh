#!/usr/bin/env bash
# Pack the package the way release does, install it into a throwaway prefix with
# DEFAULT npm flags, and prove: no platform binaries were fetched, the bin runs,
# the server answers /health. Usage: scripts/pack-smoke.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/limn-pack.XXXXXX")"
pid=""
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$work"' EXIT

cd "$root"
# Build with a full install first: vite/rollup's own native binary
# (e.g. @rollup/rollup-darwin-arm64) is itself an optionalDependency, so an
# --omit=optional install can't run the build. Re-install with --omit=optional
# right before packing instead — that's what actually determines what
# `npm pack` bundles for the packages listed in bundleDependencies (it walks
# node_modules for those packages at pack time), so the platform-binary-free
# guarantee below still holds.
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
npm run build >/dev/null
npm ci --omit=optional --ignore-scripts --no-audit --no-fund >/dev/null
tgz="$(npm pack --ignore-scripts --pack-destination "$work" 2>/dev/null | tail -1)"
echo "tarball: $tgz ($(du -h "$work/$tgz" | cut -f1))"

# 1. the tarball must not carry platform binaries
if tar -tzf "$work/$tgz" | grep -E 'claude-agent-sdk-(darwin|linux|win32)|codex-(darwin|linux|win32)'; then
  echo "::error::platform binaries found in tarball"; exit 1
fi

# 2. install with default flags into an isolated prefix
npm install -g --prefix "$work/prefix" --ignore-scripts --no-audit --no-fund "$work/$tgz" >/dev/null
pkg="$work/prefix/lib/node_modules/@glebmish/limn"
if find "$pkg" -maxdepth 4 -type d \( -name 'claude-agent-sdk-*' -o -name 'codex-darwin*' -o -name 'codex-linux*' -o -name 'codex-win32*' \) | grep .; then
  echo "::error::platform binaries were fetched on install"; exit 1
fi
echo "installed: $(du -sh "$pkg" | cut -f1)"

# 3. the bin runs and the server answers
"$work/prefix/bin/limn" --version
LIMN_DB="$work/limn.db" "$work/prefix/bin/limn" service serve --port 0 >"$work/serve.log" 2>&1 &
pid=$!
for _ in $(seq 1 50); do
  port="$(sed -n 's/.*limn\.localhost:\([0-9]*\).*/\1/p' "$work/serve.log" | head -1)"
  [ -n "$port" ] && curl -sf "http://127.0.0.1:$port/health" >/dev/null && break
  sleep 0.2
done
[ -n "${port:-}" ] || { echo "::error::server never came up"; cat "$work/serve.log"; exit 1; }
curl -s "http://127.0.0.1:$port/health" | grep -q '"app":"limn"' || { echo "::error::/health did not answer as limn"; exit 1; }
echo "pack smoke OK (port $port)"
