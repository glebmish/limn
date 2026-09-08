#!/usr/bin/env bash
# Pack a binary-free tarball from an ordinary dev tree, leaving it in the repo root.
#
# A bare `npm pack` on a dev tree trips the prepack guard: bundleDependencies are
# bundled from whatever is on disk in node_modules, and a full install carries the
# ACP adapters' optional platform binaries (~470 MB). This wraps the required dance:
# strip optionals, pack, restore the full tree. Build first (`npm run build`) —
# stripping removes rollup's own native binary, so vite can't run on the stripped
# tree. Typical use: npm run build && npm run pack:local && npm i -g ./glebmish-limn-<version>.tgz
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# Refuse a missing or stale dist/ before touching node_modules at all: `npm pack`
# bundles whatever is on disk, so a forgotten `npm run build` would silently ship a
# tarball that doesn't carry the change (finding 120, 2026-09-07 audit) — `npm run
# build` wipes dist/ first (`rm -rf dist && vite build && tsc ...`), so `dist`'s own
# mtime marks when the last build finished; any src/ file newer than that means dist/
# is stale. Can't build here instead: the --omit=optional strip below removes
# rollup's own native binary, so vite can't run on the stripped tree (see header).
if [ ! -d dist/renderer ] || [ ! -d dist/server ]; then
  echo "pack-local: dist/ is missing — run: npm run build" >&2
  exit 1
fi
if [ -n "$(find src -type f -newer dist -print -quit)" ]; then
  echo "pack-local: dist/ is older than src/ — run: npm run build" >&2
  exit 1
fi

# Restore the full tree even when the pack fails; say it out loud if that restore
# itself fails, so a half-stripped tree never lingers silently (vite/vitest would
# be broken until `npm ci`).
restore_tree() {
  (npm ci --ignore-scripts --no-audit --no-fund >/dev/null) \
    || echo "::warning::pack-local could not restore node_modules — run: npm ci" >&2
}
trap restore_tree EXIT

npm ci --omit=optional --ignore-scripts --no-audit --no-fund >/dev/null
npm pack
