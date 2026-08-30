import type { RendererApi } from '../../shared/ipc'

/** Lazy accessor: window.api is installed by api-client.ts before render —
 *  never capture it at module init. */
export function api(): RendererApi {
  return window.api
}
