type DevConfig = NonNullable<Window['limnDev']>

/** `?open=<ticket>` — a cli:open ticket minted by `limn open` (see src/server/cliOpen.ts). */
export function readOpenTicket(search: string): string | null {
  return new URLSearchParams(search).get('open')
}

/** `?dev=<json>` — screenshot/dev hooks (formerly injected by the Electron preload as
 *  window.limnDev from LIMN_* env vars). scripts/dev-url.mts builds this.
 *
 *  `enabled` is decided by the SERVER (the `limn-dev` meta tag it injects only under
 *  LIMN_DEV_HOOKS=1), never by the URL: the hooks run prompts through the user's agent
 *  and edit files, so a crafted link on its own must not be able to arm them. */
export function readDevHooks(search: string, enabled: boolean): Partial<DevConfig> {
  if (!enabled) return {}
  const raw = new URLSearchParams(search).get('dev')
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Partial<DevConfig> : {}
  } catch { return {} }
}

/** Remove consumed params so a reload doesn't replay them. */
export function stripQuery(keys: string[]): void {
  const url = new URL(window.location.href)
  let changed = false
  for (const k of keys) if (url.searchParams.has(k)) { url.searchParams.delete(k); changed = true }
  if (changed) window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash)
}
