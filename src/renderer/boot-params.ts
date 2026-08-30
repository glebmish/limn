type DevConfig = NonNullable<Window['limnDev']>

/** `?open=<ticket>` — a cli:open ticket minted by `limn open` (see src/server/cliOpen.ts). */
export function readOpenTicket(search: string): string | null {
  return new URLSearchParams(search).get('open')
}

/** `?dev=<json>` — screenshot/dev hooks (formerly injected by the Electron preload as
 *  window.limnDev from LIMN_* env vars). scripts/dev-url.mts builds this. */
export function readDevHooks(search: string): Partial<DevConfig> {
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
