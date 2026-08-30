/** Typed turn-failure classifications shared by the engine layer and its callers
 *  (`operations.ts`, `ipc.ts`). Classification is by `instanceof` — never by message
 *  text, so a genuine engine failure whose message happens to contain "cancelled" or
 *  "aborted" (e.g. an adapter's "request aborted by server") can't be mistaken for a
 *  quiet user cancel or a lost session. */

function causeSuffix(cause: unknown): string {
  const msg = cause instanceof Error ? cause.message : cause === undefined ? '' : String(cause)
  return msg ? `: ${msg}` : ''
}

/** A user-initiated cancellation surfaced as a thrown error. Engines throw this when
 *  a turn is cancelled (`session/cancel` / child kill), and callers settle it quietly
 *  (no error strip, no agent note). */
export class CancelledError extends Error {
  constructor(cause?: unknown) {
    super('cancelled', cause === undefined ? undefined : { cause })
    this.name = 'CancelledError'
  }
}

/** The thread's engine session could not be resumed — the CLI pruned/expired it.
 *  Thrown by the engine EXACTLY when a `session/resume`/`session/load` for a known
 *  session id rejects (never for spawn/protocol/capability failures, which are
 *  systemic and keep their generic copy). Callers surface the distinct
 *  "start a new chat" affordance for this. */
export class EngineSessionLostError extends Error {
  constructor(readonly engineSessionId: string, cause?: unknown) {
    super(
      `Could not resume engine session ${engineSessionId}${causeSuffix(cause)}`,
      cause === undefined ? undefined : { cause }
    )
    this.name = 'EngineSessionLostError'
  }
}

/** A cancellation surfaced as a thrown error: the typed `CancelledError`, or a genuine
 *  AbortController-style abort (`throwIfCancelled` throws a DOMException named
 *  `AbortError`). Deliberately NO message matching. */
export function isCancellation(error: unknown): boolean {
  return error instanceof CancelledError || (error instanceof Error && error.name === 'AbortError')
}
