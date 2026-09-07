import { execFile } from 'node:child_process'

// Config the parsers depend on, pinned so the end user's ~/.gitconfig can't reshape
// our output (git's own `-c` beats every config file):
//  - core.quotePath=false: emit non-ASCII path bytes verbatim instead of git's
//    C-quoted (`"caf\303\251.txt"`) form, so diff/ls-files paths round-trip and
//    match changedPaths/anchors and on-disk joins.
//  - the diff prefixes: parseUnifiedDiff strips exactly `a/` and `b/`, so
//    diff.mnemonicPrefix (`c/`…`w/` on working-tree diffs) or diff.noprefix (none)
//    would leave every FileDiff.path mis-keyed against ls-files, anchors and disk.
const HARDENED_CONFIG = [
  '-c', 'core.quotePath=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.srcPrefix=a/',
  '-c', 'diff.dstPrefix=b/'
]

function runGit(dir: string, args: string[], allowExit1: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...HARDENED_CONFIG, ...args], { cwd: dir, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
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
 *  signal; git merge-tree --write-tree's "conflict" signal) as success. Exit codes
 *  ≥ 2 remain real failures. Used only by diffContents and mergeTreeProbe — do NOT
 *  loosen the general execGit wrapper (Q9). */
export function execGitDiff(dir: string, args: string[]): Promise<string> {
  return runGit(dir, args, true)
}
