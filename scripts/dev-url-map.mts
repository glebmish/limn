/* Explicit LIMN_* env → window.limnDev hook-key map (no derivation — a regex/camelCase
 * hack here previously produced `openCmpref`/`openChatlist`, which don't match the
 * `openCmpRef`/`openChatList` fields on Window['limnDev'] and were silently dead).
 *
 * The value type of every map below is `HookKey = keyof NonNullable<Window['limnDev']>`
 * (the real hook fields declared in src/renderer/api.d.ts, picked up globally since
 * tsconfig.json compiles src/tests/scripts as one program) — so a typo'd or stale hook
 * key fails `tsc --noEmit` right here, not just in a separate test. Runtime behavior is
 * covered by tests/dev-url.test.ts. */

type HookKey = keyof NonNullable<Window['limnDev']>

/** `LIMN_X=1` → `{ [hookKey]: true }`. */
export const BOOL_KEYS: Record<string, HookKey> = {
  LIMN_SHOW_ARCHIVED: 'showArchived',
  LIMN_SCROLL_BOTTOM: 'scrollBottom',
  LIMN_OPEN_PICKER: 'openPicker',
  LIMN_OPEN_WORKSPACE: 'openWorkspace',
  LIMN_OPEN_CMPREF: 'openCmpRef',
  LIMN_OPEN_CHATLIST: 'openChatList',
  LIMN_HOLD_FOCUS: 'holdFocus',
  LIMN_RUN_BATCH: 'runBatch',
  LIMN_OPEN_MODE: 'openMode',
  LIMN_FAKE_GEN: 'fakeGen',
  LIMN_FAKE_DRIFT: 'fakeDrift',
  LIMN_FAKE_DRIFT_OPEN: 'fakeDriftOpen',
  LIMN_OPEN_SETTINGS: 'openSettings',
  LIMN_SHOW_AFFORDANCES: 'showAffordances',
  LIMN_OPEN_LAUNCHER: 'openLauncher'
}

/** `LIMN_X=<str>` → `{ [hookKey]: <str> }`. */
export const STR_KEYS: Record<string, HookKey> = {
  LIMN_FLOW: 'flow',
  LIMN_OPEN_SESSION: 'openSession',
  LIMN_OPEN_HUB: 'openHub',
  LIMN_PICK_ENGINE: 'pickEngine',
  LIMN_FOCUS: 'focus',
  LIMN_RUN_CHAT: 'runChat',
  LIMN_EXPAND_TOOL: 'expandTool',
  LIMN_OPEN_DOC: 'openDoc',
  LIMN_EDIT_FRAME: 'editFrame',
  LIMN_RUN_EDIT: 'runEdit',
  LIMN_SCENARIO: 'scenario',
  LIMN_OPEN_PEEK: 'openPeek',
  LIMN_LAUNCHER_PANE: 'launcherPane',
  LIMN_SETTINGS_TAB: 'settingsTab'
}

/** `LIMN_ACTIVE_CHAT=<n>` → `{ activeChat: Number(<n>) }` — the one numeric hook. */
export const NUMBER_ENV_KEY = 'LIMN_ACTIVE_CHAT'
export const NUMBER_HOOK_KEY: HookKey = 'activeChat'

/** Every LIMN_* env var this script recognizes, mapped to its hook key. */
export const HOOK_KEYS: Record<string, HookKey> = { ...BOOL_KEYS, ...STR_KEYS, [NUMBER_ENV_KEY]: NUMBER_HOOK_KEY }

export function buildDevHooks(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const hooks: Record<string, unknown> = {}
  for (const [envKey, hookKey] of Object.entries(BOOL_KEYS)) if (env[envKey] === '1') hooks[hookKey] = true
  for (const [envKey, hookKey] of Object.entries(STR_KEYS)) if (env[envKey]) hooks[hookKey] = env[envKey]
  if (env[NUMBER_ENV_KEY]) hooks[NUMBER_HOOK_KEY] = Number(env[NUMBER_ENV_KEY])
  return hooks
}
