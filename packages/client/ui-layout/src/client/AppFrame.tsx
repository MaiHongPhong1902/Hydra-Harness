/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * details), the drag handles (pointer capture + rAF throttle), the concession
 * chain (columns.ts), and the child-slot render decisions: the sidebar slot
 * renders HERE with live parameters from the concession solve, and the
 * session-aware occupants render in fixed column positions; strict entries
 * gate themselves on current-session availability while session-maybe
 * entries retain identity. Pure component: everything arrives
 * through the three framework shares — zero cordis or framework imports,
 * zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { SessionId, WorkspaceId } from '@hydraharness/harness-client-runtime/client'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@hydraharness/harness-client-ui-slots'
import {
  computeColumns, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import { DesktopBrowserPanel, DesktopPanelControls } from './DesktopBrowserPanel.tsx'
import { DesktopTitleBar } from './DesktopTitleBar.tsx'
import type { DesktopTitleBarAction } from './DesktopTitleBar.tsx'
import css from './AppFrame.module.css'

const DESKTOP_BROWSER_MIN = 420
const DESKTOP_TERMINAL_MIN = 240

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'review' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & { createSideSession: () => Promise<SessionId>; startSession?: () => void; openFolder?: () => Promise<void> }

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled delta reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: {
  side: 'sidebar' | 'details' | 'browser' | 'terminal'
  axis?: 'x' | 'y'
  left?: number
  label?: string
  min?: number
  max?: number
  value?: number
  onStart: () => void
  onDrag: (delta: number) => void
  onEnd?: () => void
  onStep?: (delta: number) => void
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const axis = props.axis ?? 'x'
  const desktop = props.side === 'browser' || props.side === 'terminal'
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd, onStep: props.onStep })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd, onStep: props.onStep }
  const position = useCallback((event: React.PointerEvent<HTMLDivElement>) => axis === 'x' ? event.clientX : event.clientY, [axis])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = position(e)
    latest.current = position(e)
    callbacks.current.onStart()
    setDragging(true)
  }, [position])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = position(e)
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [position])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd?.()
  }, [])
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8
    const direction = axis === 'x'
      ? event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : 0
      : event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
    if (direction === 0 || callbacks.current.onStep === undefined) return
    event.preventDefault()
    callbacks.current.onStep(direction * step)
  }, [axis])

  return (
    <div
      className={desktop ? css.desktopResizeHandle : css.handle}
      style={props.left === undefined ? undefined : { left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      role="separator"
      aria-label={props.label}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    />
  )
}

/** The three-column frame; its desktop-only right panel starts closed (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  useWorkspaces,
  actions,
  renderSlot,
  SessionProvider,
  createSideSession,
  startSession,
  openFolder,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const currentSessionId = useSessions(s => s.current)
  const currentSessionTitle = useSessions((s) => {
    const current = s.current
    if (current === undefined) return undefined
    const session = s.byId[current]
    return session?.title || session?.displayTitle
  })
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const workspaceId = useWorkspaces(state => currentSessionId === undefined
    ? state.recentWorkspaceId
    : state.items.find(workspace => workspace.sessionIds.includes(currentSessionId))?.workspaceId)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [desktopViewport, setDesktopViewport] = useState(() => ({
    height: window.innerHeight,
    width: window.innerWidth,
  }))
  const browserMax = Math.max(DESKTOP_BROWSER_MIN, Math.floor(desktopViewport.width * 2 / 3))
  const terminalMax = Math.max(DESKTOP_TERMINAL_MIN, Math.floor(desktopViewport.height / 2))
  const [browserOpen, setBrowserOpen] = useState(false)
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalWorkspaces, setTerminalWorkspaces] = useState<Array<WorkspaceId | undefined>>([])
  const [browserExpanded, setBrowserExpanded] = useState(false)
  const [browserWidth, setBrowserWidth] = useState(() =>
    clamp(Math.round(window.innerWidth * 0.42), DESKTOP_BROWSER_MIN, browserMax))
  const [terminalHeight, setTerminalHeight] = useState(() =>
    clamp(Math.round(window.innerHeight * 0.36), DESKTOP_TERMINAL_MIN, terminalMax))

  // A window resize is a rendering constraint, not a user preference. Keep
  // the preferred dimensions so a panel returns to its previous size when the
  // window grows again.
  const renderedBrowserWidth = Math.min(browserWidth, browserMax)
  const renderedTerminalHeight = Math.min(terminalHeight, terminalMax)

  useEffect(() => {
    if (!terminalOpen) return
    setTerminalWorkspaces(current => current.includes(workspaceId) ? current : [...current, workspaceId])
  }, [terminalOpen, workspaceId])

  useEffect(() => {
    if (window.hydraDesktop === undefined) return
    const onResize = () => {
      setDesktopViewport({ height: window.innerHeight, width: window.innerWidth })
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (narrow toggles flip the manual
  // re-expand override, stores.ts). Collapsed is decided here, so the
  // solver stays breakpoint-free: a narrow re-expand passes the preference
  // (or the default when the wide preference is closed) and the center
  // absorbs the squeeze.
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  const cols = computeColumns(viewport, sidebarPreference, detailsSession === undefined ? 0 : panels.details)
  const colsRef = useRef(cols)
  colsRef.current = cols

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  const browserBase = useRef(0)
  const terminalBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])
  const onBrowserStart = useCallback(() => { browserBase.current = renderedBrowserWidth }, [renderedBrowserWidth])
  const onTerminalStart = useCallback(() => { terminalBase.current = renderedTerminalHeight }, [renderedTerminalHeight])
  const onBrowserDrag = useCallback((dx: number) => {
    setBrowserWidth(clamp(browserBase.current - dx, DESKTOP_BROWSER_MIN, browserMax))
  }, [browserMax])
  const onTerminalDrag = useCallback((dy: number) => {
    setTerminalHeight(clamp(terminalBase.current - dy, DESKTOP_TERMINAL_MIN, terminalMax))
  }, [terminalMax])

  const frame = (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px` }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-dragging={dragging || undefined}
    >
      <div className={css.sidebarCol}>
        {/* Render-site slot call with live concession output: a closed
            sidebar keeps the mounted slot at the compact-rail width, and the
            component sees its rendered state as owner params decided here
            (collapsed follows the resolved rail, so a derived auto-collapse
            renders the rail UI too). */}
        {renderSlot('sidebar', {
          collapsed: sidebarCollapsed,
          width: cols.sidebar,
        })}
      </div>
      <>
        {/* Both column occupants stay at fixed tree positions from first
            paint — no loading gate: a bare status line reads worse than
            the shell's own pending rendering. The conversation
            is session-maybe; the strict details entry naturally renders
            empty while no session is current. */}
        <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>
        <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>
      </>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {/* Keyboard steps start from the rendered width like a drag does, so a
          concession-clamped column does not jump: ArrowRight grows the sidebar
          and ArrowLeft grows details, whose drag delta is inverted. */}
      {!sidebarCollapsed && (
        <DragHandle
          side="sidebar"
          left={cols.sidebar}
          label="Resize sidebar"
          min={SIDEBAR_MIN}
          max={SIDEBAR_MAX}
          value={cols.sidebar}
          onStart={onSidebarStart}
          onDrag={onSidebarDrag}
          onEnd={onDragEnd}
          onStep={(delta) => { actions.setSidebar(cols.sidebar - delta) }}
        />
      )}
      {cols.details > 0 && (
        <DragHandle
          side="details"
          left={viewport - cols.details}
          label="Resize details panel"
          min={DETAILS_MIN}
          max={DETAILS_MAX}
          value={cols.details}
          onStart={onDetailsStart}
          onDrag={onDetailsDrag}
          onEnd={onDragEnd}
          onStep={(delta) => { actions.setDetails(cols.details + delta) }}
        />
      )}
    </div>
  )
  if (window.hydraDesktop === undefined) return frame
  const toggleBrowser = () => {
    if (browserOpen) setBrowserExpanded(false)
    setBrowserOpen(!browserOpen)
  }
  const toggleExpanded = () => {
    if (!browserOpen) setBrowserOpen(true)
    setBrowserExpanded(!browserExpanded)
  }
  const onTitleBarAction = useCallback((action: DesktopTitleBarAction) => {
    switch (action) {
      case 'new-chat': startSession?.(); return
      case 'open-folder': void openFolder?.(); return
      case 'toggle-sidebar': actions.toggleSidebar(); return
      case 'toggle-bottom-panel': setTerminalOpen(open => !open); return
      case 'open-terminal': setTerminalOpen(true); return
      case 'open-browser': setBrowserOpen(true); return
      case 'settings': document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')?.click(); return
      case 'undo': case 'redo': case 'cut': case 'copy': case 'paste': case 'delete': case 'select-all':
      case 'zoom-in': case 'zoom-out': case 'reset-zoom': case 'toggle-fullscreen': case 'close': case 'quit':
        void window.hydraDesktop?.chrome?.dispatch(action)
        return
      default: return
    }
  }, [actions, openFolder, startSession])

  return (
    <div
      className={css.desktopShell}
      style={{
        '--desktop-browser-width': `${renderedBrowserWidth}px`,
        '--desktop-terminal-height': `${renderedTerminalHeight}px`,
      } as CSSProperties}
      data-browser-open={browserOpen || undefined}
      data-terminal-open={terminalOpen || undefined}
      data-browser-expanded={browserExpanded || undefined}
    >
      <DesktopTitleBar onAction={onTitleBarAction} sidebarOpen={!sidebarCollapsed}>
        <DesktopPanelControls
          browserOpen={browserOpen}
          terminalOpen={terminalOpen}
          browserExpanded={browserExpanded}
          onToggleBrowser={toggleBrowser}
          onToggleTerminal={() => { setTerminalOpen(open => !open) }}
          onToggleExpanded={toggleExpanded}
        />
      </DesktopTitleBar>
      <div className={css.desktopApp} data-desktop-shell>{frame}</div>
      <DesktopBrowserPanel
        open={browserOpen}
        workspaceId={workspaceId}
        sessionTitle={currentSessionTitle}
        createSideSession={createSideSession}
        renderSideChat={sessionId => (
          <SessionProvider sessionId={sessionId}>
            {() => renderSlot('conversation', { secondary: true })}
          </SessionProvider>
        )}
        renderReview={() => renderSlot('review', {})}
        onOpen={() => { setBrowserOpen(true) }}
      />
      {terminalWorkspaces.map((owner, index) => (
        <DesktopBrowserPanel
          key={owner ?? 'no-workspace'}
          terminalGroup={index + 1}
          workspaceId={owner}
          open={terminalOpen && !browserExpanded && owner === workspaceId}
          sessionTitle={currentSessionTitle}
          onOpen={() => { setTerminalOpen(true) }}
        />
      ))}
      {browserOpen && !browserExpanded && (
        <DragHandle
          side="browser"
          label="Resize right panel"
          min={DESKTOP_BROWSER_MIN}
          max={browserMax}
          value={renderedBrowserWidth}
          onStart={onBrowserStart}
          onDrag={onBrowserDrag}
          onStep={(delta) => {
            setBrowserWidth(clamp(renderedBrowserWidth + delta, DESKTOP_BROWSER_MIN, browserMax))
          }}
        />
      )}
      {terminalOpen && !browserExpanded && (
        <DragHandle
          side="terminal"
          axis="y"
          label="Resize Terminal panel"
          min={DESKTOP_TERMINAL_MIN}
          max={terminalMax}
          value={renderedTerminalHeight}
          onStart={onTerminalStart}
          onDrag={onTerminalDrag}
          onStep={(delta) => {
            setTerminalHeight(clamp(renderedTerminalHeight + delta, DESKTOP_TERMINAL_MIN, terminalMax))
          }}
        />
      )}
    </div>
  )
}
