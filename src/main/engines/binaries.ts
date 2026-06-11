import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/* Inside a packaged Electron app the SDK modules load from app.asar, but
   child_process cannot spawn executables from inside an asar archive
   (ENOTDIR). The binaries are unpacked via asarUnpack — resolve them there
   explicitly and hand the path to each SDK's executable override. */

const req = createRequire(import.meta.url)

function unasar(p: string): string {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

/** node_modules roots to search: packaged unpacked dir first, then dev resolution. */
function moduleRoots(): string[] {
  const roots: string[] = []
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resources) roots.push(path.join(resources, 'app.asar.unpacked', 'node_modules'))
  try {
    const sdkPkg = req.resolve('@anthropic-ai/claude-agent-sdk/package.json')
    roots.push(path.dirname(path.dirname(path.dirname(unasar(sdkPkg)))))
  } catch {
    // dev resolution unavailable
  }
  return roots
}

function findBinary(rel: string): string | undefined {
  for (const root of moduleRoots()) {
    const p = path.join(root, rel)
    if (fs.existsSync(p)) return p
  }
  return undefined
}

export function claudeBinaryPath(): string | undefined {
  return findBinary(path.join('@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'))
}

export function codexBinaryPath(): string | undefined {
  const platformDir = process.platform === 'darwin'
    ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
    : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
  return findBinary(path.join('@openai', `codex-${process.platform}-${process.arch}`, 'vendor', platformDir, 'bin', 'codex'))
}
