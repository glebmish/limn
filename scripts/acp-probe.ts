#!/usr/bin/env -S npx tsx
/**
 * Phase-0 ACP spike probe.
 *
 * Spawns the installed `@agentclientprotocol/claude-agent-acp` adapter as a
 * child process, drives it over stdio with an ACP `ClientSideConnection`, and
 * records measured facts that gate the ACP migration (see
 * specs/acp-migration/spec.md, Phase 0 + Open Questions 1/2/4/6).
 *
 * Run:  npx tsx scripts/acp-probe.ts
 * Out:  JSON report to stdout AND scripts/acp-probe-out.json
 *
 * This makes a REAL prompt turn against the user's ~/.claude credentials, i.e.
 * a real Anthropic API call. If the sandbox blocks network, re-run with the
 * Bash sandbox disabled.
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
const ADAPTER_ENTRY = join(
  REPO_ROOT,
  "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
);
const OUT_FILE = join(__dirname, "acp-probe-out.json");

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
      // restore
      try {
        await conn.setSessionMode!({
          sessionId: activeSessionId,
          modeId: original,
        });
      } catch {
        /* best effort */
      }
    }
    report.modeSwitchResults = modeSwitchResults;

    // ---- Phase: one real prompt turn ----
    let promptResult: unknown = null;
    let promptError: string | null = null;
    try {
      promptResult = await withTimeout(
        "session/prompt",
        120_000,
        conn.prompt({
          sessionId: activeSessionId,
          prompt: [
            { type: "text", text: "Reply with exactly the word: PONG" },
          ],
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
