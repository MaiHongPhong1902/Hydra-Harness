/**
 * The root entry's layout store: panel geometry as plain widths in px
 * (0 = closed), persisted to localStorage so it survives a reload. Module
 * level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle } from '@hydraharness/harness-client-runtime/client'
import {
  DETAILS_COLLAPSE_BELOW, DETAILS_DEFAULT, SIDEBAR_COLLAPSE_BELOW, SIDEBAR_DEFAULT,
} from './columns.ts'

/**
 * Layout store state: panel width preferences in px (0 = closed), plus the
 * narrow-viewport pair — `narrow` mirrors AppFrame's breakpoint reading
 * (viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can pick semantics, and
 * `narrowExpanded` is the manual override that re-expands the auto-collapsed
 * sidebar over the squeezed center without rewriting the width preference.
 */
type LayoutState = { sidebar: number; details: number; narrow: boolean; narrowExpanded: boolean }

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
}

/**
 * Create the layout panel store handle. The preference IS the width, so
 * closing a panel forgets its drag width — reopening restores the contract
 * default. Drag writes have no ceiling; crossing the collapse threshold
 * closes the panel instead of leaving an unusably thin one. Panel geometry
 * persists (localStorage) so a reopened app keeps the last size. Below the
 * auto-collapse breakpoint (AppFrame feeds setNarrow) the sidebar toggle
 * flips the narrowExpanded override instead of the preference.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({ sidebar: SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false }),
    persist: 'hydra.layout.panels',
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = px < SIDEBAR_COLLAPSE_BELOW ? 0 : Math.round(px) },
      setDetails: (d, px: number) => { d.details = px < DETAILS_COLLAPSE_BELOW ? 0 : Math.round(px) },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
    },
  })
  return handle
}
