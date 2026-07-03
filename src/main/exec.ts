import { execFile } from 'node:child_process'

// core.quotePath=false: emit non-ASCII path bytes verbatim instead of git's
// C-quoted (`"caf\303\251.txt"`) form, so diff/ls-files paths round-trip and
// match changedPaths/anchors and on-disk joins.
function runGit(dir: string, args: string[], allowExit1: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd: dir, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && !(allowExit1 && (err as { code?: number }).code === 1)) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`))
      } else resolve(stdout)
    })
  })
}

export function execGit(dir: string, args: string[]): Promise<string> {
  return runGit(dir, args, false)
}

/** Like execGit, but tolerates exit code 1 (git diff --no-index's "files differ"
 *  signal) as success. Exit codes ≥ 2 remain real failures. Used only by
 *  diffContents — do NOT loosen the general execGit wrapper (Q9). */
export function execGitDiff(dir: string, args: string[]): Promise<string> {
  return runGit(dir, args, true)
}
