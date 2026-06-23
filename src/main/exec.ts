import { execFile } from 'node:child_process'

export function execGit(dir: string, args: string[]): Promise<string> {
  // core.quotePath=false: emit non-ASCII path bytes verbatim instead of git's
  // C-quoted (`"caf\303\251.txt"`) form, so diff/ls-files paths round-trip and
  // match changedPaths/anchors and on-disk joins.
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd: dir, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`))
      else resolve(stdout)
    })
  })
}
