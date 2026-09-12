import type { RendererApi } from '../../shared/ipc'

/** Lazy accessor: window.api is set by the Electron preload, or installed
 *  asynchronously by web-api.ts before render — never capture it at module init. */
export function api(): RendererApi {
  return window.api
}
