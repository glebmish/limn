import { spawn } from 'node:child_process'

/** Open a URL in the user's default browser. Fire-and-forget; never throws. */
export function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch { /* no opener available — the URL is printed anyway */ }
}
