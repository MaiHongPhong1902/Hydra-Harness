/** Desktop-only tab host for Browser, Files, Side chat, and Terminal surfaces. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SessionId } from '@bosch/bh-client-runtime/client'
import {
  IconApiOutline14,
  IconCloseOutline16,
  IconFolderOpenOutline16,
  IconGlobeOutline14,
  IconNewChatOutline16,
  IconPlusOutline16,
} from '@bosch/bh-client-ui-primitives'
import { DesktopFilesPanel, type DesktopFilesApi } from './DesktopFilesPanel.tsx'
import { DesktopTerminalPanel } from './DesktopTerminalPanel.tsx'
import css from './DesktopBrowserPanel.module.css'

interface DesktopBrowserBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

export interface DesktopBrowserApi {
  setBounds(bounds: DesktopBrowserBounds): void
}

export type DesktopTerminalEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; code: number | null }

export interface DesktopTerminalApi {
  start(terminalId: 'bottom' | 'right', size: { cols: number; rows: number }): Promise<{ running: boolean }>
  stop(terminalId: 'bottom' | 'right'): Promise<void>
  write(terminalId: 'bottom' | 'right', data: string): void
  resize(terminalId: 'bottom' | 'right', size: { cols: number; rows: number }): void
  onEvent(terminalId: 'bottom' | 'right', listener: (event: DesktopTerminalEvent) => void): () => void
}

export type DesktopPanelShortcut = RightPanelKind

export interface DesktopPanelApi {
  onShortcut(listener: (shortcut: DesktopPanelShortcut) => void): () => void
}

declare global {
  interface Window {
    bhDesktop?: {
      browser: DesktopBrowserApi
      terminal?: DesktopTerminalApi
      files?: DesktopFilesApi
      panels?: DesktopPanelApi
    }
  }
}

type RightPanelKind = 'files' | 'side-chat' | 'browser' | 'terminal'

interface RightPanelTab {
  id: string
  kind: RightPanelKind
  label: string
  sessionId?: SessionId | undefined
}

const INITIAL_TAB: RightPanelTab = { id: 'browser', kind: 'browser', label: 'Browser' }

function PanelChooser(props: {
  activeKind?: RightPanelKind | undefined
  creating: boolean
  error?: string | undefined
  onClose: () => void
  onSelect: (kind: RightPanelKind) => void
}) {
  const browserRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => { browserRef.current?.focus() }, [])

  const row = (
    kind: RightPanelKind,
    label: string,
    icon: ReactNode,
    shortcut?: string,
    shortcutLabel?: string,
  ) => (
    <button
      ref={kind === 'browser' ? browserRef : undefined}
      type="button"
      className={css.chooserRow}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      aria-pressed={kind === 'side-chat' ? undefined : props.activeKind === kind}
      data-active={props.activeKind === kind || undefined}
      disabled={kind === 'side-chat' && props.creating}
      onClick={() => { props.onSelect(kind) }}
    >
      <span className={css.chooserIcon}>{icon}</span>
      <span>{kind === 'side-chat' && props.creating ? 'Creating side chat…' : label}</span>
      {shortcutLabel !== undefined && <kbd className={css.shortcut}>{shortcutLabel}</kbd>}
    </button>
  )

  return (
    <div
      className={css.chooserOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Choose panel"
      onKeyDown={(event) => { if (event.key === 'Escape') props.onClose() }}
    >
      <div className={css.chooserList}>
        {row('files', 'Files', <IconFolderOpenOutline16 size={14} />, 'Control+P', 'Ctrl+P')}
        {row('side-chat', 'Side chat', <IconNewChatOutline16 size={14} />, 'Control+Alt+S', 'Ctrl+Alt+S')}
        {row('browser', 'Browser', <IconGlobeOutline14 />, 'Control+T', 'Ctrl+T')}
        {row('terminal', 'Terminal', <IconApiOutline14 />, 'Control+Backquote', 'Ctrl+`')}
        {props.error !== undefined && <div className={css.chooserError}>{props.error}</div>}
      </div>
    </div>
  )
}

function IconButton(props: {
  label: string
  active: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={css.iconButton}
      aria-label={props.label}
      aria-pressed={props.active}
      data-active={props.active || undefined}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function PanelIcon({ panel }: { panel: 'expanded' | 'bottom' | 'right' }) {
  if (panel === 'expanded') {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" /></svg>
  }
  if (panel === 'bottom') {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M3 9.5h10" /></svg>
  }
  return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M9 3v10" /></svg>
}

/** Always-visible desktop layout controls; right panel and bottom Terminal stay independent. */
export function DesktopPanelControls(props: {
  browserOpen: boolean
  terminalOpen: boolean
  browserExpanded: boolean
  onToggleBrowser: () => void
  onToggleTerminal: () => void
  onToggleExpanded: () => void
}) {
  return (
    <div className={css.panelControls} aria-label="Desktop panels">
      <IconButton label="Expand right panel" active={props.browserExpanded} onClick={props.onToggleExpanded}>
        <PanelIcon panel="expanded" />
      </IconButton>
      <IconButton label="Toggle bottom terminal" active={props.terminalOpen} onClick={props.onToggleTerminal}>
        <PanelIcon panel="bottom" />
      </IconButton>
      <IconButton label="Toggle right panel" active={props.browserOpen} onClick={props.onToggleBrowser}>
        <PanelIcon panel="right" />
      </IconButton>
    </div>
  )
}

/** Codex-style tabbed right panel; each Side chat tab owns a real session surface. */
export function DesktopBrowserPanel(props: {
  open: boolean
  chooserOpen: boolean
  createSideSession: () => Promise<SessionId>
  renderSideChat: (sessionId: SessionId) => ReactNode
  onCloseChooser: () => void
  onToggleChooser: () => void
  onOpen: () => void
}) {
  const { createSideSession, onCloseChooser, onOpen } = props
  const api = window.bhDesktop?.browser
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const sideChatNumber = useRef(0)
  const [tabs, setTabs] = useState<RightPanelTab[]>([INITIAL_TAB])
  const [activeId, setActiveId] = useState(INITIAL_TAB.id)
  const [creating, setCreating] = useState(false)
  const [chooserError, setChooserError] = useState<string>()
  const activeTab = tabs.find(tab => tab.id === activeId)

  const selectPanel = useCallback((kind: RightPanelKind) => {
    onOpen()
    setChooserError(undefined)
    if (kind === 'side-chat') {
      setCreating(true)
      void createSideSession().then((sessionId) => {
        sideChatNumber.current += 1
        const number = sideChatNumber.current
        const tab: RightPanelTab = {
          id: `side-chat:${sessionId}`,
          kind,
          label: number === 1 ? 'Side chat' : `Side chat ${number}`,
          sessionId,
        }
        setTabs(current => [...current, tab])
        setActiveId(tab.id)
        onCloseChooser()
      }).catch((reason: unknown) => {
        setChooserError(String(reason))
      }).finally(() => { setCreating(false) })
      return
    }
    setTabs((current) => {
      const existing = current.find(tab => tab.kind === kind)
      if (existing !== undefined) {
        setActiveId(existing.id)
        return current
      }
      const tab: RightPanelTab = { id: kind, kind, label: kind.charAt(0).toUpperCase() + kind.slice(1) }
      setActiveId(tab.id)
      return [...current, tab]
    })
    onCloseChooser()
  }, [createSideSession, onCloseChooser, onOpen])

  useEffect(() => window.bhDesktop?.panels?.onShortcut((shortcut) => {
    selectPanel(shortcut)
  }), [selectPanel])

  const closeTab = (id: string) => {
    setTabs((current) => {
      const index = current.findIndex(tab => tab.id === id)
      if (index < 0) return current
      if (current[index]?.kind === 'terminal') void window.bhDesktop?.terminal?.stop('right')
      const next = current.filter(tab => tab.id !== id)
      if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? '')
      return next
    })
  }

  useLayoutEffect(() => {
    if (api === undefined) return
    const viewport = viewportRef.current
    if (viewport === null || !props.open || activeTab?.kind !== 'browser') {
      api.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false })
      return
    }
    let frame: number | undefined
    let coveredByModal = document.querySelector('[role="dialog"][aria-modal="true"]') !== null
    const report = () => {
      frame = undefined
      const rect = viewport.getBoundingClientRect()
      api.setBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
        visible: props.open && !props.chooserOpen && !coveredByModal && rect.width > 0 && rect.height > 0,
      })
    }
    const schedule = () => { frame ??= requestAnimationFrame(report) }
    const observer = new ResizeObserver(schedule)
    const modalObserver = new MutationObserver(() => {
      const next = document.querySelector('[role="dialog"][aria-modal="true"]') !== null
      if (next === coveredByModal) return
      coveredByModal = next
      report()
    })
    observer.observe(viewport)
    modalObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['aria-modal', 'role'],
      childList: true,
      subtree: true,
    })
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      observer.disconnect()
      modalObserver.disconnect()
      window.removeEventListener('resize', schedule)
      if (frame !== undefined) cancelAnimationFrame(frame)
      api.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false })
    }
  }, [activeTab?.kind, api, props.chooserOpen, props.open])

  return (
    <section
      className={css.panel}
      aria-label="Right panel"
      data-desktop-panel="browser"
      hidden={!props.open}
    >
      <header className={css.header} role="tablist" aria-label="Right panel tabs">
        <div className={css.tabs}>
          {tabs.map(tab => (
            <div className={css.tab} data-active={tab.id === activeId || undefined} key={tab.id}>
              <button
                type="button"
                className={css.tabSelect}
                role="tab"
                aria-selected={tab.id === activeId}
                onClick={() => { setActiveId(tab.id); setChooserError(undefined); props.onCloseChooser() }}
              >
                {tab.kind === 'files' && <IconFolderOpenOutline16 size={13} />}
                {tab.kind === 'side-chat' && <IconNewChatOutline16 size={13} />}
                {tab.kind === 'browser' && <IconGlobeOutline14 size={13} />}
                {tab.kind === 'terminal' && <IconApiOutline14 size={13} />}
                <span>{tab.label}</span>
              </button>
              <button type="button" className={css.tabClose} aria-label={`Close ${tab.label}`} onClick={() => { closeTab(tab.id) }}>
                <IconCloseOutline16 size={12} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={css.addTab}
          aria-label="Choose panel"
          aria-expanded={props.chooserOpen}
          onClick={props.onToggleChooser}
        >
          <IconPlusOutline16 size={14} />
        </button>
      </header>
      <div className={css.panelBody}>
        {tabs.map(tab => (
          <div className={css.surface} hidden={tab.id !== activeId} data-panel-kind={tab.kind} key={tab.id}>
            {tab.kind === 'browser' && <div ref={viewportRef} className={css.viewport} aria-label="Browser page" />}
            {tab.kind === 'files' && <DesktopFilesPanel />}
            {tab.kind === 'side-chat' && tab.sessionId !== undefined && (
              <div className={css.sideChat}>{props.renderSideChat(tab.sessionId)}</div>
            )}
            {tab.kind === 'terminal' && <DesktopTerminalPanel open={props.open && tab.id === activeId} terminalId="right" embedded />}
          </div>
        ))}
        {tabs.length === 0 && (
          <div className={css.emptyPanel}>
            <span>No panel is open.</span>
            <button type="button" onClick={props.onToggleChooser}>Add panel</button>
          </div>
        )}
        {props.chooserOpen && (
          <PanelChooser
            activeKind={activeTab?.kind}
            creating={creating}
            error={chooserError}
            onClose={props.onCloseChooser}
            onSelect={selectPanel}
          />
        )}
      </div>
    </section>
  )
}
