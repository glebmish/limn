# ACP adapters — pinning & version-bump playbook

Limn drives both engines through the **Agent Client Protocol (ACP)**. Neither engine
is integrated directly anymore; each is reached through a pinned npm **adapter** that
translates ACP into the engine's native CLI. This doc is the operational companion to
[agent-layer.md](agent-layer.md) — how the adapters are pinned, what a deliberate
engine upgrade looks like, and how to verify one before release.

## What is pinned, and where

| Package | Role | `package.json` |
| --- | --- | --- |
| `@agentclientprotocol/claude-agent-acp` | Claude adapter; pins `@anthropic-ai/claude-agent-sdk` transitively | exact pin |
| `@agentclientprotocol/codex-acp` | Codex adapter; pins `@openai/codex` transitively | exact pin |
| `@agentclientprotocol/sdk` | ACP client library (`ClientSideConnection`, NDJSON transport) | exact pin |

The pins are **exact** (no `^`) on purpose. The adapter version *is* the pinned
engine-protocol version: bumping the adapter is the one deliberate way to move the
engine runtime under Limn. `@anthropic-ai/claude-agent-sdk` is **not** a direct
dependency — it arrives only transitively, pinned by claude-agent-acp.

Two things are decoupled from the adapter version:

- **The native CLIs** (`claude`, `codex`) are the user's own installs, resolved from
  PATH or a Settings override and fed to the adapter via `CLAUDE_CODE_EXECUTABLE` /
  `CODEX_PATH` (`binaries.ts` → `AcpEngineConfig.binaryEnv`). The user keeps these
  current and logged in; Limn pins only the *protocol* layer.
- **The negotiated protocol version** is hard-pinned to `1` at `initialize`. An
  adapter that answers with anything else fails the turn with an actionable error —
  never a silent downgrade.

## Packaging

`package.json`'s `bundleDependencies` vendors the adapters + their JS SDK glue into the
npm tarball, built after `npm ci --omit=optional` so the SDKs' native platform binaries
(`@anthropic-ai/claude-agent-sdk-*` ≈ 225 MB, `@openai/codex-*` ≈ 242 MB, both declared
as `optionalDependencies`) are **never shipped and never fetched on install**. npm
installs the vendored subtree as-is, so a user needs no special flags.

The shipped runtime closure is the two adapter scopes (`@agentclientprotocol/**`,
`@anthropic-ai/**`), `zod`, and `@modelcontextprotocol/sdk` — the last drags in an
express/hono tree that dominates the installed footprint (≈ 4.9 MB tarball, ≈ 35 MB on
disk). Slimming it is a known follow-up.

> ⚠ **Codex hard-requires `CODEX_PATH`.** claude-agent-acp can self-discover `claude`,
> but codex-acp's only fallback when `CODEX_PATH` is unset is the *bundled*
> `@openai/codex` binary — which packaging strips. `CODEX_ACP_CONFIG.binaryRequired` +
> the `runAcpTurn` preflight catch a missing `codex` and surface the friendly
> `engineBinaryStatus` hint instead of a raw `MODULE_NOT_FOUND`. If you ever change how
> packing strips those binaries, re-verify the spawn smoke below.

## Bumping an adapter (deliberate engine upgrade)

1. **Bump the pin** in `package.json` (exact version, no caret) and `npm install`.
   Confirm the lockfile moved and, for Claude, that the transitive
   `@anthropic-ai/claude-agent-sdk` version changed as expected.
2. **Run the engine suite** — the CI gate:
   ```
   npx vitest run tests/acp-engine.test.ts tests/acpEvents.test.ts \
     tests/approvalPolicy.test.ts tests/adapters.test.ts tests/structured.test.ts
   npx tsc --noEmit
   ```
   These run against `FakeAcpAgent` (scripted NDJSON ACP over stdio) — no network, no
   creds. A green suite proves the mapper/ladder/config contract still holds.
3. **Re-probe capabilities** against the *real* new adapter and diff the report against
   your previous run (the reports are local and gitignored — they carry machine paths and
   session ids):
   ```
   npx tsx scripts/acp-probe.ts --engine=claude   # → scripts/acp-probe-out.json
   npx tsx scripts/acp-probe.ts --engine=codex    # → scripts/acp-probe-out-codex.json
   ```
   Check the load-bearing facts encoded in `adapters.ts` still hold: negotiated
   `protocolVersion === 1`, `agentCapabilities.loadSession`, `mcpCapabilities.http`,
   and the advertised **mode ids** per tier (`modeFor`). If a mode id was renamed or
   a capability dropped, update `AcpEngineConfig` — that record is the single place
   these live.
4. **Real-adapter smoke** — one live `chat` turn per engine (needs `~/.claude` /
   `~/.codex` creds + network):
   ```
   npx tsx scripts/acp-smoke.ts --engine=claude
   npx tsx scripts/acp-smoke.ts --engine=codex
   ```
5. **Package + spawn-verify** — pack the package the way release does and confirm the
   adapters still load from the installed, native-binary-stripped layout:
   ```
   npm run pack:smoke
   ```
   It builds under a full install, re-installs with `npm ci --omit=optional`, `npm pack`s,
   asserts the tarball carries no `claude-agent-sdk-*` / `codex-<platform>` directory,
   installs the tarball into a throwaway prefix with **default** npm flags, and curls
   `/health`. Then spawn each bundled adapter with plain `node` (`CODEX_PATH` set for
   codex) and confirm an `initialize` handshake returns `protocolVersion: 1` — i.e. the
   module graph resolves with the native binaries absent. The adapters live under
   `<global node_modules>/@glebmish/limn/node_modules/@agentclientprotocol/…`.
6. **Manual launch smoke** — `npm i -g` the packed tarball, run `limn`, and exercise
   generate / chat / batch with an approval on each engine (the GUI path the scripts
   can't cover).

## When exit criteria fail

The `ReviewEngine` seam keeps a native reimplementation possible and the adapters are
Apache-2.0 (vendorable / forkable). If a bump regresses, revert the pin — the previous
exact version is a one-line rollback. Adapter ownership has already moved orgs twice
(`zed-industries/*` → `agentclientprotocol/*`); pinning + this playbook are the guard.
