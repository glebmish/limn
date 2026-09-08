import type { StoreApi } from 'zustand'

/**
 * zustand v5's bare `useStore()` reads `getInitialState()` for the SSR snapshot:
 * `renderToStaticMarkup` drives React's `useSyncExternalStore` through its SERVER
 * snapshot, which is the store's INITIAL state, not a `setState`-mutated one. So a
 * component's store reads under a characterization/SSR render have to be seeded by
 * mutating that object in place, not by calling `setState`.
 *
 * `create<T>()(...)` (zustand 5.0.14, `node_modules/zustand/vanilla.d.ts`) types
 * `getInitialState` as `() => T` directly on the bound store — no cast is needed to
 * call it.
 */
export function initialStateOf<T>(store: StoreApi<T>): T {
  return store.getInitialState()
}
