/** Names the save chord for the hint text in FlowFrame's head: `⌘⏎` on Apple
 *  platforms (`navigator.platform` strings like 'MacIntel', 'iPhone', 'iPad'),
 *  `Ctrl+⏎` everywhere else — the save keymap itself already accepts both on every
 *  platform (see FlowFrame's `onKeyDown`); this only names the one worth advertising. */
export function saveChordLabel(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? '⌘⏎' : 'Ctrl+⏎'
}
