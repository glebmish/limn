import { hostForUrl } from '../server/guard.js'

export interface HealthInfo { app: 'limn'; version: string; pid: number; startedAt: string; port: number }

/** GET /health on the address the service was told to bind (loopback by default — see
 *  serviceTarget). Null when nothing answers or the answer isn't Limn. */
export async function probeHealth(port: number, host = '127.0.0.1'): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`http://${hostForUrl(host)}:${port}/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const body = (await res.json()) as Partial<HealthInfo>
    return body && body.app === 'limn' && typeof body.version === 'string' ? (body as HealthInfo) : null
  } catch { return null }
}
