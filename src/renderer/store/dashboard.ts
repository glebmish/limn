import type { StateCreator } from 'zustand'
import type { DashboardData } from '../../shared/ipc'
import { api } from '../lib/api'
import type { AppStore } from './index'

/** The dashboard landing screen: the repo/session index, the recent-repo list, the
 *  filter box, and the keyboard-selected row. */
export interface DashboardSlice {
  recents: string[]
  dashboard: DashboardData | null
  filter: string
  sel: number
  loadDashboard(): Promise<void>
  setFilter(s: string): void
  openRepository(): Promise<void>
}

export const createDashboardSlice: StateCreator<AppStore, [], [], DashboardSlice> = (set, get) => ({
  recents: [],
  dashboard: null,
  filter: '',
  sel: 0,

  async loadDashboard() {
    try {
      const dashboard = await api().dashboard()
      set({ dashboard, recents: dashboard.recents, error: null })
      if (dashboard.notices.length > 0) set({ error: dashboard.notices.join(' ') })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  setFilter(s) {
    set({ filter: s, sel: 0 })
  },

  async openRepository() {
    // escape hatch: open a one-off repo without pinning; openRepo records it, so it
    // shows up under Recent afterwards
    const dir = await api().pickRepo()
    if (dir) await get().openRepo(dir)
  }
})
