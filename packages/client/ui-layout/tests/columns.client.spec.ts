import { describe, expect, it } from 'vitest'
import {
  computeColumns, DETAILS_DEFAULT, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT,
} from '@hydraharness/harness-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number) => width
const closed = (_width: number) => 0

describe('computeColumns', () => {
  it('everything renders at its exact preference when it fits', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 1920 - 280 - 360, details: 360 })
  })

  it('closed sidebar keeps its compact rail while closed details contribute zero width', () => {
    expect(computeColumns(1920, closed(300), closed(360)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1920 - SIDEBAR_COLLAPSED, details: 0 })
  })

  it('no drag ceiling: a wide preference renders exactly as dragged, center absorbing the rest', () => {
    const cols = computeColumns(1920, open(900), open(500))
    expect(cols).toEqual({ sidebar: 900, center: 1920 - 900 - 500, details: 500 })
  })

  it('no protected center floor: sidebar and details together may push center to zero', () => {
    const cols = computeColumns(900, open(500), open(400))
    expect(cols).toEqual({ sidebar: 500, center: 0, details: 400 })
  })

  it('a sidebar preference wider than the viewport is capped at the viewport; center and details go to zero', () => {
    expect(computeColumns(500, open(900), open(360))).toEqual({ sidebar: 500, center: 0, details: 0 })
  })

  it('details is capped at whatever the sidebar leaves behind, never past it', () => {
    const cols = computeColumns(900, open(700), open(400))
    expect(cols).toEqual({ sidebar: 700, center: 0, details: 200 })
  })

  it('tiny viewport: even the sidebar caps at the viewport itself, details and center go to zero', () => {
    const cols = computeColumns(200, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 200, center: 0, details: 0 })
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    // 500 - 280 = 220 left for details, squeezed well below its 360 preference.
    const squeezed = computeColumns(500, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(squeezed).toEqual({ sidebar: 280, center: 0, details: 220 })
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})
