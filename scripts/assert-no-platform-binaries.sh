#!/usr/bin/env bash
# prepack guard.
#
# `npm pack` / `npm publish` bundle whatever is on disk in node_modules for every
# package listed in bundleDependencies. On a developer's ordinary tree that includes
# the platform binaries npm fetched as optional deps of the ACP adapters
# (@anthropic-ai/claude-agent-sdk-<platform>, @openai/codex-<platform>) — ~470 MB of
# them — and a hand-run `npm publish` would ship that, single-platform, to everyone.
#
# Release CI packs from a stripped tree (`npm ci --omit=optional`), so this passes
# there; scripts/pack-smoke.sh does the same before its own pack. If you hit this
# locally and really meant to pack, run `npm ci --omit=optional` first (then
# `npm ci` to get your build tools back).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

found=""
for d in "$root"/node_modules/@anthropic-ai/claude-agent-sdk-* "$root"/node_modules/@openai/codex-*; do
  [ -d "$d" ] && found="$found$d"$'\n'
done

if [ -n "$found" ]; then
  echo "::error::platform binaries present in node_modules — packing would bundle them:"
  printf '%s' "$found"
  echo "run 'npm ci --omit=optional' before packing (see scripts/pack-smoke.sh)"
  exit 1
fi
echo "no platform binaries in node_modules — safe to pack"
