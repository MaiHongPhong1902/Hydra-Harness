// @vitest-environment jsdom
/**
 * createLayoutStore unit account: init shape, the action write set (collapse
 * threshold inside actions, otherwise the exact dragged width kept
 * unclamped), and localStorage persistence across instances.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createLayoutStore } from '@hydraharness/harness-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_COLLAPSE_BELOW, DETAILS_DEFAULT, SIDEBAR_COLLAPSE_BELOW, SIDEBAR_DEFAULT,
} from '@hydraharness/harness-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'hydra.layout.panels'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes the sidebar at its default width, details closed, wide viewport assumed', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({ sidebar: SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false })
  })

  it('setSidebar/setDetails keep the exact dragged width — no ceiling', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(900)
    expect(store.getSnapshot().sidebar).toBe(900)
    actions.setDetails(1200)
    expect(store.getSnapshot().details).toBe(1200)
  })

  it('setSidebar/setDetails snap closed once the drag crosses the collapse threshold', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(SIDEBAR_COLLAPSE_BELOW - 1)
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.setDetails(DETAILS_COLLAPSE_BELOW - 1)
    expect(store.getSnapshot().details).toBe(0)
  })

  it('toggleSidebar flips closed <-> contract default (drag width forgotten)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('narrow toggleSidebar flips only the re-expand override; the width preference survives', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toEqual({ sidebar: 400, details: 0, narrow: true, narrowExpanded: true })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('crossing the breakpoint drops the override; a same-value setNarrow keeps it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(false)
    expect(store.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('openDetails uses the contract default, preserves an open width, and closeDetails zeroes', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.setDetails(500)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(500)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('persists panel geometry and rehydrates a later instance from the same key', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openDetails()
    first.actions.setDetails(500)
    expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({
      sidebar: 400, details: 500, narrow: false, narrowExpanded: false,
    })

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toEqual({
      sidebar: 400, details: 500, narrow: false, narrowExpanded: false,
    })
  })
})
