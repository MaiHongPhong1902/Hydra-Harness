// Menu: minimal controlled dropdown (group-by pickers, project selectors).
// Default: pure CSS positioning relative to the anchor wrapper — no popper.
// Opt-in `portal` renders the list into its enclosing dialog or document.body, fixed-positioned from
// the anchor rect, for anchors inside overflow-clipping containers (sidebar).
// The owner controls `open`; outside-click closing uses one document listener
// active only while open. Submenus open on hover/focus inside the same root.
// Entries also cover non-interactive `label` headings and `danger` rows.
// Lists keep 12px clearance to the viewport's top/bottom edges and scroll
// internally past that; fixed submenu cards independently fit the viewport.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { IconCheckOutline16, IconChevronRightOutline14 } from './icons/index.tsx'
import { usePointerGrace } from './pointer-grace.ts'
import css from './Menu.module.css'

/** Selectable row (optionally with a nested submenu). */
export interface MenuItem {
  id: string
  label: ReactNode
  disabled?: boolean
  /** Trailing keyboard shortcut or availability hint. */
  hint?: string
  /** Explanation for an unavailable action. */
  title?: string
  /** Leading icon (figma .Menu_cell gap 8). */
  icon?: ReactNode
  /** Destructive row: error-colored text/icon and danger hover fill. */
  danger?: boolean
  /** Nested card opened to the right on hover/focus. */
  submenu?: readonly MenuItem[]
}

/** Hairline between item groups (not selectable). */
export interface MenuSeparator {
  type: 'separator'
  id: string
}

/** Non-interactive heading row above a group of items. */
export interface MenuLabel {
  type: 'label'
  id: string
  text: string
}

/** One primary-menu entry: a row, a separator, or a heading label. */
export type MenuEntry = MenuItem | MenuSeparator | MenuLabel

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
  return 'type' in entry && entry.type === 'separator'
}

function isLabel(entry: MenuEntry): entry is MenuLabel {
  return 'type' in entry && entry.type === 'label'
}

/** Unplaced portal list: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real. */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

/** Keyboard navigation stays in the nearest card and skips unavailable actions. */
function navigateMenu(event: ReactKeyboardEvent<HTMLDivElement>, closeSubmenu: () => void): void {
  if (!(event.target instanceof HTMLElement)) return
  const menu = event.target.closest('[role="menu"]')
  if (menu === null) return
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
    .filter(item => !item.disabled && item.closest('[role="menu"]') === menu)
  const index = items.indexOf(event.target as HTMLButtonElement)
  const key = event.key
  if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
    event.preventDefault()
    event.stopPropagation()
    const next = key === 'Home' ? 0 : key === 'End' ? items.length - 1
      : (index + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  } else if (key === 'ArrowRight' && event.target.getAttribute('aria-haspopup') === 'menu') {
    event.preventDefault()
    event.stopPropagation()
    const button = event.target as HTMLButtonElement
    button.click()
    requestAnimationFrame(() => { button.parentElement?.querySelector<HTMLButtonElement>(':scope > [role="menu"] > button:not(:disabled)')?.focus() })
  } else if (key === 'ArrowLeft' && menu.parentElement?.querySelector(':scope > button[aria-haspopup]') !== null) {
    event.preventDefault()
    event.stopPropagation()
    menu.parentElement?.querySelector<HTMLButtonElement>(':scope > button[aria-haspopup]')?.focus()
    closeSubmenu()
  }
}

/**
 * Render an anchored dropdown menu.
 * @param props.open - whether the list is showing (owner-controlled).
 * @param props.anchor - the trigger element (rendered in place).
 * @param props.items - selectable rows and optional separators.
 * @param props.selectedId - row shown as selected.
 * @param props.selectedIds - rows shown as selected when a menu contains independent option groups.
 * @param props.onSelect - row click callback (not called for disabled rows or submenu parents that only open children).
 * @param props.onClose - invoked on outside click or Escape.
 * @param props.align - list alignment against the anchor (default 'start').
 * @param props.side - open below (`bottom`, default) or above (`top`) the anchor.
 * @param props.portal - render the list into its enclosing dialog or document.body, fixed-positioned
 * from the anchor rect (repositions on scroll/resize while open). Use when an
 * ancestor's overflow clipping would crop the in-place list; default false
 * keeps the pure-CSS in-place behavior.
 * @param props.closeOnPointerLeave - close the list once the pointer has left
 * both trigger and list for the pointer grace (default false keeps it open
 * until outside click/Escape/selection). The grace makes the 4px trigger->list
 * gap and a brief overshoot survivable; coming back cancels the close.
 * @param props.dense - reduce vertical row spacing without changing the standard typography or card width.
 * @param props.compact - use reduced menu typography and spacing.
 * @param props.getAnchorRect - portal mode only: supply the anchor rect
 * directly (e.g. from a host-owned trigger button) instead of measuring the
 * Menu's own wrapper span. Required when the wrapper isn't itself laid out at
 * the trigger (render-prop anchors, effect-positioned proxies — measuring the
 * wrapper there races the host's layout effects). Called on open and on every
 * scroll/resize; return null to skip placement for that frame.
 * @param props.footer - rows pinned below the scrolling items area, separated
 * by a hairline; they stay visible while the items above scroll.
 * @param props.autoFocus - focus the first available item when opened, for context-menu keyboard entry.
 * @returns anchor wrapper with the conditional list.
 */
export function Menu({ open, anchor, items, selectedId, selectedIds, onSelect, onClose, align = 'start', side = 'bottom', portal = false, closeOnPointerLeave = false, dense = false, compact = false, getAnchorRect, footer, className, autoFocus = false }: {
  open: boolean
  anchor: ReactNode
  items: readonly MenuEntry[]
  footer?: readonly MenuEntry[]
  selectedId?: string | undefined
  selectedIds?: readonly string[] | undefined
  onSelect: (id: string) => void
  onClose: () => void
  align?: 'start' | 'end'
  side?: 'bottom' | 'top' | 'right'
  portal?: boolean
  closeOnPointerLeave?: boolean
  dense?: boolean
  compact?: boolean
  getAnchorRect?: () => DOMRect | null
  className?: string
  autoFocus?: boolean
}) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null)
  const [fixedPos, setFixedPos] = useState<CSSProperties | null>(null)
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(onClose)
  const { arm: armSubClose, cancel: cancelSubClose } = usePointerGrace(() => { setOpenSubmenuId(null) })
  const placed = !portal || fixedPos !== null

  useLayoutEffect(() => {
    // A hidden portal cannot receive focus before its placement commit.
    if (open && autoFocus && placed) listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open, autoFocus, placed])

  useLayoutEffect(() => {
    if (!open || openSubmenuId === null) return
    const submenu = listRef.current?.querySelector<HTMLDivElement>(`.${css.submenu}`)
    const button = submenu?.parentElement?.querySelector('button')
    if (submenu === undefined || submenu === null || button === undefined || button === null) return
    const place = () => {
      const rect = button.getBoundingClientRect()
      const width = submenu.offsetWidth
      const right = rect.right + 6
      const x = right + width <= window.innerWidth - 12 ? right : rect.left - width - 6
      submenu.style.left = `${Math.max(12, Math.min(x, window.innerWidth - width - 12))}px`
      submenu.style.top = `${Math.max(12, Math.min(rect.top, window.innerHeight - submenu.offsetHeight - 12))}px`
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open, openSubmenuId])

  // Portal mode: fixed-position the list from the anchor rect before paint;
  // track the anchor while open (capture-phase scroll catches nested panes).
  // getAnchorRect trumps measuring the wrapper span: a child layout effect
  // runs before the parent's, so a wrapper the host positions in its own
  // effect measures stale here — the host callback owns the truth instead.
  useLayoutEffect(() => {
    if (!open || !portal) { setFixedPos(null); return }
    const place = () => {
      let r: DOMRect | null
      if (getAnchorRect !== undefined) {
        r = getAnchorRect()
      } else {
        /* v8 ignore next 2 -- the ref is attached before the layout effect runs and the listeners die with it. */
        r = rootRef.current?.getBoundingClientRect() ?? null
      }
      if (r === null) return
      const MARGIN = 12
      const vw = window.innerWidth
      const vh = window.innerHeight
      const listEl = listRef.current
      const lw = listEl?.offsetWidth ?? 0
      const lh = listEl?.offsetHeight ?? 0

      let x: number
      let y: number
      if (side === 'right') {
        x = r.right + 4
        y = r.top
      } else if (align === 'start') {
        x = r.left
        y = side === 'bottom' ? r.bottom + 4 : r.top - lh - 4
      } else {
        x = r.right - lw
        y = side === 'bottom' ? r.bottom + 4 : r.top - lh - 4
      }

      if (lw > 0) x = Math.min(Math.max(x, MARGIN), vw - lw - MARGIN)
      if (lh > 0) y = Math.min(Math.max(y, MARGIN), vh - lh - MARGIN)

      setFixedPos({ left: x, top: y })
    }
    // First run measures the hidden pre-render (same commit as `open`), so
    // end/top alignment and clamping use real dimensions before anything
    // paints — no visible jump from a zero-size first guess.
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, portal, align, side, getAnchorRect])

  useEffect(() => {
    if (!open) {
      setOpenSubmenuId(null)
      return
    }
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return
      // The portaled list is outside the anchor subtree; check both.
      if (rootRef.current?.contains(e.target) === true) return
      if (listRef.current?.contains(e.target) === true) return
      onClose()
    }
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
      rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, onClose])

  // A close from selection/Escape/outside click outruns a pending grace close;
  // left armed it would shut a list reopened inside the grace window. Its own
  // effect, not the listener effect above: that one re-runs on every `onClose`
  // identity change and would cancel the grace mid-transit.
  useEffect(() => {
    if (!open) cancelClose()
  }, [open, cancelClose])

  const renderEntry = (entry: MenuEntry) => {
    if (isSeparator(entry)) {
      return <div key={entry.id} className={css.separator} role="separator" />
    }
    if (isLabel(entry)) {
      return <div key={entry.id} className={css.label} role="presentation">{entry.text}</div>
    }
    const hasSub = entry.submenu !== undefined && entry.submenu.length > 0
    const subOpen = hasSub && openSubmenuId === entry.id
    const selected = entry.id === selectedId || selectedIds?.includes(entry.id) === true
    return (
      <div
        key={entry.id}
        className={css.itemWrap}
        onMouseEnter={() => { cancelSubClose(); setOpenSubmenuId(hasSub && entry.disabled !== true ? entry.id : null) }}
        onMouseLeave={armSubClose}
      >
        <button
          type="button"
          role="menuitem"
          className={clsx(css.item, selected && css.selected, entry.danger === true && css.danger)}
          disabled={entry.disabled}
          title={entry.title}
          aria-haspopup={hasSub ? 'menu' : undefined}
          aria-expanded={hasSub ? subOpen : undefined}
          onFocus={() => { cancelSubClose(); setOpenSubmenuId(hasSub ? entry.id : null) }}
          onClick={() => {
            if (hasSub) {
              setOpenSubmenuId(entry.id)
              return
            }
            onSelect(entry.id)
          }}
        >
          {entry.icon !== undefined && <span className={css.itemIcon}>{entry.icon}</span>}
          <span className={css.itemLabel}>{entry.label}</span>
          {/* Selection marker is a trailing check (figma .Menu_cell), not a fill. */}
          {selected && <IconCheckOutline16 className={css.check} />}
          {entry.hint !== undefined && <span className={css.hint} aria-hidden="true">{entry.hint}</span>}
          {hasSub && <IconChevronRightOutline14 className={css.check} />}
        </button>
        {subOpen && entry.submenu !== undefined && (
          <div className={clsx(css.submenu, compact && css.compactList)} role="menu">
            {entry.submenu.map(sub => (
              <button
                key={sub.id}
                type="button"
                role="menuitem"
                className={css.item}
                disabled={sub.disabled}
                title={sub.title}
                onClick={() => { onSelect(sub.id) }}
              >
                {sub.icon !== undefined && <span className={css.itemIcon}>{sub.icon}</span>}
                <span className={css.itemLabel}>{sub.label}</span>
                {selectedIds?.includes(sub.id) === true && <IconCheckOutline16 className={css.check} />}
                {sub.hint !== undefined && <span className={css.hint} aria-hidden="true">{sub.hint}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Portal lists render hidden until placed: the placement effect measures
  // this pre-render in the same commit, so the first painted frame is
  // already at the final position (with getAnchorRect returning null the
  // list simply stays hidden).
  const list = open && (
    <div
      ref={listRef}
      className={clsx(css.list, dense && css.denseList, compact && css.compactList, css.scrollable, portal && css.portal, side === 'top' && !portal && css.sideTop, align === 'end' && !portal && css.alignEnd)}
      style={portal ? fixedPos ?? MEASURE_STYLE : undefined}
      role="menu"
      onKeyDown={(event) => { navigateMenu(event, () => { setOpenSubmenuId(null) }) }}
      // React portals bubble synthetic events through the REACT tree: without
      // this stop, an item click re-fires the anchor row's own onClick
      // (open/toggle) after onSelect.
      onClick={(e) => { e.stopPropagation() }}
    >
      <div className={css.viewport} role="presentation">
        {items.map(renderEntry)}
      </div>
      {footer !== undefined && footer.length > 0 && (
        <div className={css.footer} role="presentation">
          {footer.map(renderEntry)}
        </div>
      )}
    </div>
  )

  // Pointer-leave dismissal watches the WRAPPER, not the list: React's
  // enter/leave traversal runs over the React tree, so trigger and portaled
  // list are one region here. Aiming back at the trigger, or crossing the 4px
  // gap between them, therefore never counts as leaving.
  return (
    <span
      ref={rootRef}
      className={clsx(css.root, className)}
      onPointerEnter={closeOnPointerLeave ? cancelClose : undefined}
      onPointerLeave={closeOnPointerLeave ? () => { if (open) armClose() } : undefined}
    >
      {anchor}
      {portal ? (list !== false && createPortal(list, rootRef.current?.closest('[role="dialog"]') ?? document.body)) : list}
    </span>
  )
}
