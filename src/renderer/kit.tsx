import type { SVGProps, ReactNode } from 'react'
import type { EngineId } from '../shared/types'

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
  // engine marks — official monochrome brand logos (currentColor), viewBox 24.
  claude: (p: P) => <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" /></svg>,
  codex: (p: P) => <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" {...p}><path fillRule="evenodd" clipRule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z" /></svg>,
  // plan artifact — a neutral clipboard/checklist glyph (was the AI spark)
  plan: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" {...p}><rect x="3" y="2.5" width="8" height="10" rx="1.2" /><path d="M5.3 2.5V1.7h3.4v.8z" /><path d="M5 6l1 1 1.4-1.6M5 9.3l1 1 1.4-1.6M8.7 5.8h1.6M8.7 9.1h1.6" /></svg>,
  send: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12.5 1.5L6 8M12.5 1.5l-4 11-2.5-4.5L1.5 5z" /></svg>,
  copy: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" {...p}><rect x="4.5" y="4.5" width="7.5" height="8" rx="1.2" /><path d="M9.5 4.5V2.5h-7v8h2" /></svg>,
  filter: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M1.5 3h11l-4 4.5V12l-3-1.5V7.5z" /></svg>,
  eye: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}><path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><circle cx="7" cy="7" r="1.6" /></svg>,
  diff: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...p}><path d="M3.5 2v6M3.5 8a2 2 0 0 0 2 2h3M10.5 12V6M10.5 6a2 2 0 0 0-2-2h-3" /><circle cx="3.5" cy="2" r="1.2" fill="currentColor" /><circle cx="10.5" cy="12" r="1.2" fill="currentColor" /></svg>,
  doc: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" {...p}><path d="M3.5 1.5h5L11 4v8.5H3.5z" /><path d="M8 1.5V4h2.5M5 7h4M5 9.5h4" /></svg>,
  branch: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" {...p}><circle cx="3.5" cy="3" r="1.5" /><circle cx="3.5" cy="11" r="1.5" /><circle cx="10.5" cy="4.5" r="1.5" /><path d="M3.5 4.5v5M3.5 8.5C3.5 6 10.5 7 10.5 6" /></svg>,
  gear: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" {...p}><circle cx="7" cy="7" r="2" /><path d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2M3.1 3.1l1.4 1.4M9.5 9.5l1.4 1.4M10.9 3.1L9.5 4.5M4.5 9.5l-1.4 1.4" /></svg>,
  x: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" {...p}><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" /></svg>,
  trash: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M2.5 3.5h9M5.5 3.5V2.3h3v1.2M3.5 3.5l.6 8h5.8l.6-8M6 6v3.5M8 6v3.5" /></svg>,
  // tool-call verbs (wf-D), ported from the wireframe A.* set
  search: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...p}><circle cx="6" cy="6" r="3.5" /><path d="M8.7 8.7L12 12" /></svg>,
  edit: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" {...p}><path d="M9.5 2.5l2 2L5 11l-2.5.5L3 9z" /><path d="M8.5 3.5l2 2" /></svg>,
  term: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="1.5" y="2.5" width="11" height="9" rx="1.3" /><path d="M4 6l2 1.5L4 9M7.5 9.5h3" /></svg>,
  list: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...p}><path d="M5 4h7M5 7h7M5 10h7M2.3 4h.01M2.3 7h.01M2.3 10h.01" /></svg>,
  // worktree — a folder (the branch's checkout directory)
  folder: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" {...p}><path d="M1.8 11.4V4.6a.8.8 0 0 1 .8-.8h2.7l1.2 1.5h4.9a.8.8 0 0 1 .8.8v5.3a.8.8 0 0 1-.8.8H2.6a.8.8 0 0 1-.8-.8z" /></svg>,
  // repos / dashboard root (a house) — for going up to the repositories list
  home: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" {...p}><path d="M2 6.6 7 2.4l5 4.2M3.4 5.5V11.6h7.2V5.5" /></svg>,
  warn: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M7 1.8l5.5 9.7H1.5z" /><path d="M7 5.7v2.6M7 10h.01" /></svg>,
  // execution-mode tiers (approvals ladder)
  lock: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" {...p}><rect x="2.7" y="6.2" width="8.6" height="5.6" rx="1.2" /><path d="M4.4 6.2V4.6a2.6 2.6 0 0 1 5.2 0v1.6" /></svg>,
  unlock: (p: P) => <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" {...p}><rect x="2.7" y="6.2" width="8.6" height="5.6" rx="1.2" /><path d="M4.4 6.2V4.6a2.6 2.6 0 0 1 5.1-.6" /></svg>
}

export function Ava({ ai, children }: { ai?: boolean; children: ReactNode }) {
  return <span className={'ava' + (ai ? ' ava-ai' : '')}>{children}</span>
}

/** The one comment affordance for any review element: a green "+" that reveals on
 *  hover in the element's left gutter (never a bubble on the right). `extra` adds a
 *  per-context positioning class; the host element drives the hover reveal. */
export function CmtPlus({ onClick, extra, stop }: {
  onClick: () => void; extra?: string; stop?: boolean
}) {
  return (
    <button
      className={'spec-plus' + (extra ? ' ' + extra : '')}
      tabIndex={-1}
      onClick={(e) => { if (stop) e.stopPropagation(); onClick() }}
    >
      <I.plus style={{ width: 12, height: 12 }} />
      <span className="plus-tip">comment</span>
    </button>
  )
}

/** The brand mark for the engine an action is attributed to — Anthropic sunburst
 *  (claude) or OpenAI knot (codex). Falls back to the Claude mark (the default
 *  engine) when the engine is unknown. */
export function EngineGlyph({ engine, ...p }: { engine?: EngineId } & P) {
  const Mark = engine === 'codex' ? I.codex : I.claude
  return <Mark {...p} />
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

export function ago(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}
