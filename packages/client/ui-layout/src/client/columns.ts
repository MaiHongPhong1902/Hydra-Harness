/**
 * Pure column solver for the three-column AppFrame. The sidebar and details
 * panels render at the exact width the user dragged them to — no drag
 * ceiling, and no protected center floor: widening either panel shrinks the
 * center down to zero before it touches the other panel. The only
 * arithmetic floor is physical (a column cannot render wider than the
 * viewport, and center cannot go negative). A drag or keyboard step thin
 * enough to read as "close it" is caught earlier, in the layout store's
 * setSidebar/setDetails (SIDEBAR_COLLAPSE_BELOW / DETAILS_COLLAPSE_BELOW) —
 * this solver only ever sees an already-resolved 0-or-real-width
 * preference. The SIDEBAR_AUTO_COLLAPSE breakpoint is consumed by AppFrame,
 * which decides the effective sidebar preference before solving; the solver
 * itself stays breakpoint-free.
 */

/** Resolved widths for one frame; center is the remainder and may be zero. */
export interface Columns { sidebar: number; center: number; details: number }

/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Dragging (or stepping) the sidebar narrower than this closes it to the rail instead. */
export const SIDEBAR_COLLAPSE_BELOW = 160
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360
/** Dragging (or stepping) details narrower than this closes the panel instead. */
export const DETAILS_COLLAPSE_BELOW = 200

/**
 * Solve the three column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only. Sidebar and
 * details each render at their preference, capped only at the space
 * physically available (never wider than the viewport, and details never
 * wider than what the sidebar leaves behind); center absorbs whatever
 * remains, down to zero.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @returns resolved widths; details 0 means visually closed (never unmounted), while a closed sidebar keeps its compact rail.
 */
export function computeColumns(viewport: number, sidebar: number, details: number): Columns {
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : Math.min(Math.round(sidebar), Math.max(0, viewport))
  const d = details === 0 ? 0 : Math.min(Math.round(details), Math.max(0, viewport - s))
  return { sidebar: s, center: Math.max(0, viewport - s - d), details: d }
}
