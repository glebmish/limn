#!/usr/bin/env -S npx tsx
/**
 * ACP spike probe (Phase 0: Claude, Phase 2: Codex).
 *
 * Spawns an installed ACP adapter as a child process, drives it over stdio with
 * an ACP `ClientSideConnection`, and records measured facts that gate the ACP
 * migration (see specs/acp-migration/spec.md, Phase 0/2 + Open Questions
 * 1/2/4/6).
 *
 * Run:  npx tsx scripts/acp-probe.ts [--engine=claude|codex]   (default: claude)
 * Out:  JSON report to stdout AND scripts/acp-probe-out[-codex].json
 *
 * This makes a REAL prompt turn against the user's ~/.claude or ~/.codex
 * credentials, i.e. a real Anthropic/OpenAI API call. If the sandbox blocks
 * network, re-run with the Bash sandbox disabled.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** Per-engine adapter entry + report filename. */
const ENGINES = {
  claude: {
    adapterEntry:
      "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
    outFile: "acp-probe-out.json",
    // Most-restrictive mode for the --elicit-permission run (a command must ask).
    restrictiveModeId: "default",
  },
  codex: {
    adapterEntry: "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
    outFile: "acp-probe-out-codex.json",
    restrictiveModeId: "read-only",
  },
} as const;
type EngineKey = keyof typeof ENGINES;

/** `--engine=<key>` (default claude). */
function parseEngine(argv: string[]): EngineKey {
  const arg = argv.find((a) => a.startsWith("--engine="));
  const raw = arg ? arg.slice("--engine=".length) : "claude";
  if (raw in ENGINES) return raw as EngineKey;
  throw new Error(
    `unknown --engine=${raw}; expected one of ${Object.keys(ENGINES).join("|")}`,
  );
}

const ENGINE = parseEngine(process.argv.slice(2));
const ADAPTER_ENTRY = join(REPO_ROOT, ENGINES[ENGINE].adapterEntry);
// --elicit-permission: run the turn at the most-restrictive mode with a command-
// triggering prompt so the adapter emits a `session/request_permission` we can
// answer (validates the approval round-trip + tool_call shapes). Writes to a
// separate output file so it never clobbers the default handshake report.
const ELICIT_PERMISSION = process.argv.slice(2).includes("--elicit-permission");
const OUT_FILE = join(
  __dirname,
  ELICIT_PERMISSION
    ? ENGINES[ENGINE].outFile.replace(/\.json$/, "-perm.json")
    : ENGINES[ENGINE].outFile,
);

/** Reject a promise if it does not settle within `ms`. */
function withTimeout<T>(label: string, ms: number, p: T | PromiseLike<T>): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(
      () => rej(new Error(`phase timed out after ${ms}ms: ${label}`)),
      ms,
    );
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t);
        res(v);
      },
      (e) => {
        clearTimeout(t);
        rej(e);
      },
    );
  });
}

/** A shape-signature so we sample one payload per DISTINCT update shape. */
function shapeKey(update: Record<string, unknown>): string {
  const disc = String(update.sessionUpdate);
  if (disc === "tool_call" || disc === "tool_call_update") {
    return `${disc}:${String(update.status ?? "?")}`;
  }
  if (disc === "agent_message_chunk" || disc === "agent_thought_chunk") {
    const c = update.content as { type?: string } | undefined;
    return `${disc}:${c?.type ?? "?"}`;
  }
  return disc;
}

async function main() {
  const report: Record<string, unknown> = {
    meta: {
      engine: ENGINE,
      probeStartedAt: new Date().toISOString(),
      adapterEntry: ADAPTER_ENTRY,
      repoRoot: REPO_ROOT,
      sdkProtocolVersion: PROTOCOL_VERSION,
      node: process.version,
    },
  };

  // ---- collectors shared with the Client handler ----
  const sessionUpdates: SessionNotification[] = [];
  const updateOrder: string[] = [];
  const updateSamples: Record<string, unknown> = {};
  const permissionRequests: unknown[] = [];

  // intentional initial state: the client permission handler (closure below) may read
  // it before session/new resolves.
  // eslint-disable-next-line no-useless-assignment
  let activeSessionId: string | null = null;

  const client: Client = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      sessionUpdates.push(params);
      const update = params.update as unknown as Record<string, unknown>;
      const key = shapeKey(update);
      updateOrder.push(String(update.sessionUpdate));
      if (!(key in updateSamples)) updateSamples[key] = update;
    },
    async requestPermission(
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      permissionRequests.push(params);
      const options = params.options ?? [];
      // Prefer the allow_once option; fall back to the first option.
      const allow =
        options.find((o) => o.kind === "allow_once") ?? options[0];
      if (!allow) {
        return { outcome: { outcome: "cancelled" } };
      }
      return {
        outcome: { outcome: "selected", optionId: allow.optionId },
      };
    },
    // fs / terminal capabilities are declined at initialize; if the agent
    // calls them anyway, fail loudly rather than silently satisfy.
    async readTextFile(_p: ReadTextFileRequest) {
      throw new Error("fs.readTextFile declined by probe client");
    },
    async writeTextFile(_p: WriteTextFileRequest) {
      throw new Error("fs.writeTextFile declined by probe client");
    },
  };

  // ---- spawn the adapter ----
  let child: ChildProcessWithoutNullStreams | null = null;
  const stderrChunks: string[] = [];

  try {
    child = spawn(process.execPath, [ADAPTER_ENTRY], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    }) as ChildProcessWithoutNullStreams;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      stderrChunks.push(d);
      process.stderr.write(`[adapter] ${d}`);
    });
    child.on("error", (e) => {
      stderrChunks.push(`spawn error: ${String(e)}`);
    });

    const toAgent = Writable.toWeb(
      child.stdin,
    ) as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(
      child.stdout,
    ) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(toAgent, fromAgent);

    // The deprecated-but-working wiring Phase 1's acp.ts will mirror.
    const conn: Agent = new ClientSideConnection(() => client, stream);

    // ---- Phase: initialize ----
    const initResult = await withTimeout(
      "initialize",
      20_000,
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
    );
    report.initialize = initResult;
    report.derived = {
      negotiatedProtocolVersion: initResult.protocolVersion,
      protocolVersionEqualsSdk:
        initResult.protocolVersion === PROTOCOL_VERSION,
      loadSession: initResult.agentCapabilities?.loadSession ?? null,
      mcpCapabilities: initResult.agentCapabilities?.mcpCapabilities ?? null,
      promptCapabilities:
        initResult.agentCapabilities?.promptCapabilities ?? null,
      sessionCapabilities:
        (initResult.agentCapabilities as Record<string, unknown> | undefined)
          ?.sessionCapabilities ?? null,
      authMethods: initResult.authMethods ?? null,
    };

    // ---- Phase: session/new ----
    const newSession = await withTimeout(
      "session/new",
      30_000,
      conn.newSession({ cwd: REPO_ROOT, mcpServers: [] }),
    );
    activeSessionId = newSession.sessionId;
    report.newSession = newSession;
    const modes = (newSession as Record<string, unknown>).modes as
      | {
          currentModeId: string;
          availableModes: Array<{
            id: string;
            name: string;
            description?: string;
          }>;
        }
      | undefined;
    report.modes = modes ?? null;
    // Session Config Options (OQ6): codex-acp exposes per-turn model + reasoning
    // effort here (configIds `model` / `reasoning_effort`); claude exposes model
    // + effort too. Surface them explicitly for the passthrough decision.
    report.configOptions =
      (newSession as Record<string, unknown>).configOptions ?? null;

    // ---- Phase: set-session-mode for each available mode, then restore ----
    const modeSwitchResults: Array<{
      id: string;
      ok: boolean;
      error?: string;
    }> = [];
    if (modes?.availableModes?.length) {
      const original = modes.currentModeId;
      for (const m of modes.availableModes) {
        try {
          await withTimeout(
            `set_mode:${m.id}`,
            10_000,
            conn.setSessionMode!({
              sessionId: activeSessionId,
              modeId: m.id,
            }),
          );
          modeSwitchResults.push({ id: m.id, ok: true });
        } catch (e) {
          modeSwitchResults.push({
            id: m.id,
            ok: false,
            error: String(e),
          });
        }
      }
      // For --elicit-permission, leave the session in the most-restrictive mode
      // so a command asks; otherwise restore the original mode.
      const finalModeId = ELICIT_PERMISSION
        ? (ENGINES[ENGINE].restrictiveModeId as string)
        : original;
      try {
        await conn.setSessionMode!({
          sessionId: activeSessionId,
          modeId: finalModeId,
        });
      } catch {
        /* best effort */
      }
      report.finalModeId = finalModeId;
    }
    report.modeSwitchResults = modeSwitchResults;

    // ---- Phase: one real prompt turn ----
    // Default: a trivial text turn. --elicit-permission: a command-triggering
    // prompt at restrictive mode so the adapter requests permission.
    // A WRITE command is used (not a read like `ls`): Codex's read-only sandbox
    // auto-allows non-escalating reads and only asks (session/request_permission)
    // when a command must escape the sandbox to write/reach network.
    const promptText = ELICIT_PERMISSION
      ? "Run this exact shell command and report the result: `echo ok > acp_probe_scratch.txt`. You must actually execute it as a command."
      : "Reply with exactly the word: PONG";
    let promptResult: unknown = null;
    let promptError: string | null = null;
    try {
      promptResult = await withTimeout(
        "session/prompt",
        120_000,
        conn.prompt({
          sessionId: activeSessionId,
          prompt: [{ type: "text", text: promptText }],
        }),
      );
    } catch (e) {
      promptError = String(e);
    }
    report.prompt = {
      result: promptResult,
      stopReason:
        (promptResult as { stopReason?: string } | null)?.stopReason ?? null,
      error: promptError,
    };
    report.sessionUpdateOrder = updateOrder;
    report.sessionUpdateShapes = Object.keys(updateSamples);
    report.sessionUpdateSamples = updateSamples;
    report.permissionRequests = permissionRequests;
    report.agentTextConcat = sessionUpdates
      .map((n) => {
        const u = n.update as unknown as {
          sessionUpdate: string;
          content?: { type?: string; text?: string };
        };
        return u.sessionUpdate === "agent_message_chunk" &&
          u.content?.type === "text"
          ? u.content.text
          : "";
      })
      .join("");

    report.status = promptError ? "DONE_WITH_CONCERNS" : "DONE";
  } catch (e) {
    report.status = "BLOCKED";
    report.fatalError = String(e);
    if (e instanceof Error && e.stack) report.fatalStack = e.stack;
  } finally {
    report.stderr = stderrChunks.join("");
    // Teardown: end stdin, kill the process group-ish (the child alone here).
    try {
      child?.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    report.meta = {
      ...(report.meta as object),
      probeEndedAt: new Date().toISOString(),
    };
  }

  const json = JSON.stringify(report, null, 2);
  writeFileSync(OUT_FILE, json);
  process.stdout.write(json + "\n");
  process.stdout.write(`\n[probe] wrote ${OUT_FILE}\n`);
  // Force exit — the adapter child + web streams can keep the loop alive.
  process.exit(report.status === "BLOCKED" ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`[probe] fatal: ${String(e)}\n`);
  process.exit(1);
});
