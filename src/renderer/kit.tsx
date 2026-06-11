import type { SVGProps, ReactNode } from 'react'

type P = SVGProps<SVGSVGElement>

/* Icon set ported from wf-kit.jsx */
export const I = {
  check: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M2.5 7.5l3 3 6-7" /></svg>,
  dotg: (p: P) => <svg viewBox="0 0 14 14" fill="currentColor" {...p}><circle cx="7" cy="7" r="3.2" /></svg>,
  changed: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" {...p}><path d="M11.5 5A5 5 0 0 0 3 3.2M2.5 9A5 5 0 0 0 11 10.8" /><path d="M11.5 2v3h-3M2.5 12V9h3" /></svg>,
  bubble: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" {...p}><path d="M2 3.2h10v6.2H7l-2.8 2.2V9.4H2z" /></svg>,
  chevR: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 3l4 4-4 4" /></svg>,
  chevD: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 5l4 4 4-4" /></svg>,
  arrow: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M2 7h9M8 4l3 3-3 3" /></svg>,
  plus: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" {...p}><path d="M7 3v8M3 7h8" /></svg>,
  flag: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 12V2M3 2.5h7l-1.5 2.5L10 8H3" /></svg>,
  spark: (p: P) => <svg viewBox="0 0 14 14" fill="currentColor" {...p}><path d="M7 1l1.1 3.4L11.5 5.5 8.1 6.7 7 10 5.9 6.7 2.5 5.5l3.4-1.1z" /></svg>,
  send: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12.5 1.5L6 8M12.5 1.5l-4 11-2.5-4.5L1.5 5z" /></svg>,
  copy: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" {...p}><rect x="4.5" y="4.5" width="7.5" height="8" rx="1.2" /><path d="M9.5 4.5V2.5h-7v8h2" /></svg>,
  filter: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M1.5 3h11l-4 4.5V12l-3-1.5V7.5z" /></svg>,
  eye: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}><path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><circle cx="7" cy="7" r="1.6" /></svg>,
  diff: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...p}><path d="M3.5 2v6M3.5 8a2 2 0 0 0 2 2h3M10.5 12V6M10.5 6a2 2 0 0 0-2-2h-3" /><circle cx="3.5" cy="2" r="1.2" fill="currentColor" /><circle cx="10.5" cy="12" r="1.2" fill="currentColor" /></svg>,
  doc: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" {...p}><path d="M3.5 1.5h5L11 4v8.5H3.5z" /><path d="M8 1.5V4h2.5M5 7h4M5 9.5h4" /></svg>,
  branch: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}><circle cx="3.5" cy="3" r="1.5" /><circle cx="3.5" cy="11" r="1.5" /><circle cx="10.5" cy="4.5" r="1.5" /><path d="M3.5 4.5v5M3.5 8.5C3.5 6 10.5 7 10.5 6" /></svg>,
  gear: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}><circle cx="7" cy="7" r="2" /><path d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2M3.1 3.1l1.4 1.4M9.5 9.5l1.4 1.4M10.9 3.1L9.5 4.5M4.5 9.5l-1.4 1.4" /></svg>,
  x: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" {...p}><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>
}

export function Ava({ ai, children }: { ai?: boolean; children: ReactNode }) {
  return <span className={'ava' + (ai ? ' ava-ai' : '')}>{children}</span>
}

export function DiagramNodeBox({ kind, title, sub }: { kind?: string; title: string; sub?: string }) {
  return <div className={'node' + (kind ? ' ' + kind : '')}>{title}{sub && <div className="sm">{sub}</div>}</div>
}

export function Flow() {
  return <span className="flowarrow">→</span>
}

export function Delta({ add, del }: { add: number; del: number }) {
  return <span className="delta"><span className="add">+{add}</span> <span className="del">−{del}</span></span>
}

export function ficonClass(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'fi-ts', tsx: 'fi-ts', mts: 'fi-ts',
    js: 'fi-js', jsx: 'fi-js', mjs: 'fi-js', cjs: 'fi-js',
    css: 'fi-css', scss: 'fi-css', less: 'fi-css',
    md: 'fi-md', markdown: 'fi-md', txt: 'fi-md',
    json: 'fi-json', yaml: 'fi-json', yml: 'fi-json', toml: 'fi-json',
    go: 'fi-go', py: 'fi-go', rb: 'fi-go', rs: 'fi-go', java: 'fi-go'
  }
  return map[ext] ?? 'fi-md'
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}
