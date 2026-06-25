import fs from 'node:fs'
import path from 'node:path'

/* Engine CLI resolution: the user's system-installed `claude` / `codex` from
   PATH. Nothing is bundled — the SDKs' platform binaries are excluded from the
   app package (see electron-builder.yml), so the user supplies the CLIs via
   their own installs and keeps them current. */

function fromPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, name)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile() || fs.lstatSync(p).isSymbolicLink()) return p
    } catch {
      // not here
    }
  }
  return undefined
}

export function claudeBinaryPath(): string | undefined {
  return fromPath('claude')
}

export function codexBinaryPath(): string | undefined {
  return fromPath('codex')
}
