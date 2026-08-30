#!/usr/bin/env bash
# Pack the package the way release does, install it into a throwaway prefix, and
# prove: no platform binaries were fetched, the bin runs, the server answers /health.
# Installs run with --ignore-scripts: nothing in the tree needs an install-time
# script, and skipping them keeps the smoke deterministic. Usage: scripts/pack-smoke.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/limn-pack.XXXXXX")"
pid=""
# Restore the developer's tree on the way out: this script deliberately leaves
# node_modules at `--omit=optional` (that is what makes the packed tarball
# binary-free), which also strips rollup's own native binary — so vite/vitest would
# stop working after a local run until you reinstalled by hand. Release CI re-strips
# with its own `npm ci --omit=optional` before `npm pack`, so this restore costs it
# nothing but a reinstall. A failed restore is said out loud: silently leaving a
# half-stripped tree behind is exactly the confusion this trap exists to prevent.
restore_tree() {
  (cd "$root" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null) \
    || echo "::warning::pack-smoke could not restore node_modules — run: npm ci" >&2
}
trap 'kill "$pid" 2>/dev/null || true; rm -rf "$work"; restore_tree' EXIT

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
# --ignore-scripts skips our own prepack guard, so assert the same thing directly:
# the tarball's contents are decided by what is in node_modules right now.
scripts/assert-no-platform-binaries.sh >/dev/null
# npm's notices go to stderr along with any real error; keep them out of the captured
# filename but show them when the pack itself fails.
tgz="$(npm pack --ignore-scripts --pack-destination "$work" 2>"$work/pack.err" | tail -1)" \
  || { echo "::error::npm pack failed"; cat "$work/pack.err" >&2; exit 1; }
echo "tarball: $tgz ($(du -h "$work/$tgz" | cut -f1))"

# 1. the tarball must not carry platform binaries
# (capture the listing first: piping straight into `if tar ... | grep ...`
# would let a failing tar silently pass, since grep's own no-match exit
# status masks it once both are inside the pipeline being tested)
tar_listing="$(tar -tzf "$work/$tgz")"
if grep -E 'claude-agent-sdk-(darwin|linux|win32)|codex-(darwin|linux|win32)' <<<"$tar_listing"; then
  echo "::error::platform binaries found in tarball"; exit 1
fi

# 2. install into an isolated prefix (a global install, like a user's `npm i -g`)
npm install -g --prefix "$work/prefix" --ignore-scripts --no-audit --no-fund "$work/$tgz" >/dev/null
pkg="$work/prefix/lib/node_modules/@glebmish/limn"
# no -maxdepth: a platform binary nested deeper than 4 levels would be missed
install_listing="$(find "$pkg" -type d \( -name 'claude-agent-sdk-*' -o -name 'codex-darwin*' -o -name 'codex-linux*' -o -name 'codex-win32*' \))"
if [ -n "$install_listing" ]; then
  echo "::error::platform binaries were fetched on install"; echo "$install_listing"; exit 1
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
