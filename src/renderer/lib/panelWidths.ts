/** The two resizable panels in the review shell: the guided-review rail (left) and
 *  the chat drawer (right). */
export type PanelKind = 'sidebar' | 'chat'

export interface PanelSpec { default: number; min: number; max: number }

export const PANELS: Record<PanelKind, PanelSpec> = {
  sidebar: { default: 286, min: 220, max: 520 },
  chat: { default: 320, min: 260, max: 640 }
}

/** The main pane (diff / editor) never shrinks below this width, regardless of how
 *  wide the sidebar and chat panels are dragged. */
export const MAIN_MIN = 480

/** Pixels moved per arrow-key resize step. */
export const KEY_STEP = 16

/** The viewport guard (see clampPanelWidth) can push a width below the panel's own
 *  `min`, but never below this — a panel narrower than this is unusable. */
export const HARD_FLOOR = 160

/** The pref key each panel's width is stored under. The prefs slice happens to name
 *  its state fields the same, so this record also indexes the store (see ShellHandle
 *  in Review.tsx) — keep the two in step. */
export const PREF_KEYS: Record<PanelKind, 'sidebarWidth' | 'chatWidth'> = {
  sidebar: 'sidebarWidth',
  chat: 'chatWidth'
}

/** The divider's aria-label per panel. */
export const PANEL_LABELS: Record<PanelKind, string> = {
  sidebar: 'Resize sidebar',
  chat: 'Resize chat drawer'
}

/** Which way a rightward drag moves a panel's width: the rail sits LEFT of its
 *  handle (dragging right grows it), the drawer sits RIGHT of its handle. */
export const PANEL_DIRECTIONS: Record<PanelKind, 1 | -1> = { sidebar: 1, chat: -1 }

/** Clamp `value` into the panel's own [min, max] range — the reviewer's PREFERRED
 *  width. No viewport is involved: this is what gets stored and persisted, so a
 *  temporarily narrow window can never overwrite a preference with a squeezed
 *  width. */
export function clampPanelRange(kind: PanelKind, value: number): number {
  const spec = PANELS[kind]
  return Math.min(Math.max(value, spec.min), spec.max)
}

/** Clamp `value` into the panel's [min, max] range, then apply the viewport guard:
 *  the main pane must keep at least MAIN_MIN px, so the panel is further capped to
 *  `viewport - other - MAIN_MIN` (`other` is the other panel's current width, 0 when
 *  it's closed). The guard runs AFTER the range clamp, so it can push the result
 *  below the panel's `min` — but never below HARD_FLOOR. The result is the panel's
 *  EFFECTIVE width: what gets painted and announced, never what gets stored. */
export function clampPanelWidth(kind: PanelKind, value: number, viewport: number, other: number): number {
  const ranged = clampPanelRange(kind, value)
  const guard = viewport - other - MAIN_MIN
  return Math.max(Math.min(ranged, guard), HARD_FLOOR)
}

/** Both panels' EFFECTIVE widths for the current viewport, derived from the stored
 *  PREFERRED widths. The guard has to run on both panels or they would each claim
 *  the same slack and together squeeze the main pane below MAIN_MIN, so the order is
 *  fixed: the sidebar is clamped first (against the chat's *preferred* width, or 0
 *  when the drawer is closed), then the chat is clamped against the *clamped*
 *  sidebar. That makes the sidebar the pessimistic one — it surrenders slack the
 *  chat then gets to keep — but it is deterministic and guarantees
 *  `viewport - sidebar - chat >= MAIN_MIN` except where HARD_FLOOR overrides.
 *  The chat width is computed even when the drawer is closed so opening it paints
 *  the right width immediately. Nothing here is stored: widen the window and the
 *  preferred widths come back. */
export function effectiveWidths(
  { sidebar, chat, chatOpen, viewport }: { sidebar: number; chat: number; chatOpen: boolean; viewport: number }
): { sidebar: number; chat: number } {
  const s = clampPanelWidth('sidebar', sidebar, viewport, chatOpen ? chat : 0)
  return { sidebar: s, chat: clampPanelWidth('chat', chat, viewport, s) }
}

/** Whether a finished gesture is worth a store write + pref round-trip: a bare
 *  click, a drag that lands back where it started, or an End key at the max all
 *  produce the width that is already committed. */
export function shouldPersist(next: number, committed: number): boolean {
  return next !== committed
}

/** Parse a stored pref (a JSON string, or undefined when unset) into a clamped
 *  width. Falls back to the panel's default on missing/unparseable/non-finite
 *  input — no viewport is known here, so only the range clamp applies. */
export function parseStoredWidth(kind: PanelKind, raw: string | undefined): number {
  const spec = PANELS[kind]
  if (raw == null) return spec.default
  let value: unknown
  try { value = JSON.parse(raw) } catch { return spec.default }
  if (typeof value !== 'number' || !Number.isFinite(value)) return spec.default
  return clampPanelRange(kind, value)
}

/** The CSS custom property a panel's width is written to — both the initial
 *  `panelVars` inline style below and the shell's imperative writes during a
 *  pointer drag (the shell bypasses the store on every move, so a drag doesn't
 *  ripple a store update through the whole review tree; see ShellHandle in
 *  Review.tsx). */
export function panelVarName(kind: PanelKind): '--gside-w' | '--chat-w' {
  return kind === 'sidebar' ? '--gside-w' : '--chat-w'
}

/** The CSS custom properties the shell sets on its root element for the current
 *  sidebar / chat widths. */
export function panelVars(sidebarWidth: number, chatWidth: number): Record<string, string> {
  return { [panelVarName('sidebar')]: `${sidebarWidth}px`, [panelVarName('chat')]: `${chatWidth}px` }
}
