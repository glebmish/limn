import { execFile } from 'node:child_process'

export function execGit(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`))
      else resolve(stdout)
    })
  })
}
