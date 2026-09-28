import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronLeftOutline14, IconChevronRightOutline14, IconPanelLeftOutline16 } from '@hydraharness/harness-client-ui-primitives'
import { Menu, Tooltip } from '@hydraharness/harness-client-ui-primitives'
import type { MenuEntry } from '@hydraharness/harness-client-ui-primitives'
import css from './DesktopTitleBar.module.css'

export type DesktopTitleBarAction =
  | 'new-chat' | 'open-folder' | 'toggle-sidebar' | 'toggle-bottom-panel' | 'open-terminal' | 'open-browser'
  | 'back' | 'forward'
  | 'settings' | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'select-all'
  | 'zoom-in' | 'zoom-out' | 'reset-zoom' | 'toggle-fullscreen' | 'close' | 'quit'
  | 'documentation' | 'keyboard-shortcuts' | 'whats-new' | 'troubleshooting' | 'system-status'
  | 'send-feedback' | 'task-manager' | 'performance-trace' | 'check-updates' | 'about'

export interface DesktopTitleBarProps {
  onAction: (action: DesktopTitleBarAction) => void
  canGoBack?: boolean
  canGoForward?: boolean
  sidebarOpen: boolean
  children?: ReactNode
}

function shortcut(label: string, keys: string): ReactNode {
  return <><span>{label}</span><span className={css.shortcut}>{keys}</span></>
}

const separator = (id: string): MenuEntry => ({ type: 'separator', id })

const FILE_ITEMS: readonly MenuEntry[] = [
  { id: 'new-chat', label: shortcut('New Chat', 'Ctrl+N') },
  { id: 'new-temporary-chat', label: shortcut('New Temporary Chat', 'Ctrl+Shift+N'), disabled: true },
  separator('file-1'),
  { id: 'open-folder', label: shortcut('Open Folder…', 'Ctrl+O') },
  separator('file-2'),
  { id: 'close', label: shortcut('Close', 'Ctrl+W') },
  separator('file-3'),
  { id: 'quit', label: shortcut('Quit Hydra', 'Ctrl+Q') },
]

const EDIT_ITEMS: readonly MenuEntry[] = [
  { id: 'undo', label: shortcut('Undo', 'Ctrl+Z') },
  { id: 'redo', label: shortcut('Redo', 'Ctrl+Y') },
  separator('edit-1'),
  { id: 'cut', label: shortcut('Cut', 'Ctrl+X') },
  { id: 'copy', label: shortcut('Copy', 'Ctrl+C') },
  { id: 'paste', label: shortcut('Paste', 'Ctrl+V') },
  { id: 'delete', label: shortcut('Delete', 'Del') },
  separator('edit-2'),
  { id: 'select-all', label: shortcut('Select All', 'Ctrl+A') },
  separator('edit-3'),
  { id: 'settings', label: shortcut('Settings…', 'Ctrl+,') },
]

const VIEW_ITEMS: readonly MenuEntry[] = [
  { id: 'toggle-sidebar', label: shortcut('Toggle Sidebar', 'Ctrl+B') },
  { id: 'toggle-bottom-panel', label: shortcut('Toggle Bottom Panel', 'Ctrl+J') },
  { id: 'open-terminal', label: shortcut('Open Terminal', 'Ctrl+`') },
  { id: 'open-files', label: shortcut('Toggle File Tree', 'Ctrl+Shift+E'), disabled: true },
  separator('view-1'),
  { id: 'open-browser', label: shortcut('Browser', 'Ctrl+Shift+B') },
  separator('view-2'),
  { id: 'find', label: shortcut('Find', 'Ctrl+F'), disabled: true },
  separator('view-3'),
  { id: 'back', label: shortcut('Back', 'Ctrl+['), disabled: true },
  { id: 'forward', label: shortcut('Forward', 'Ctrl+]'), disabled: true },
  separator('view-4'),
  { id: 'zoom-in', label: shortcut('Zoom In', 'Ctrl+Shift+=') },
  { id: 'zoom-out', label: shortcut('Zoom Out', 'Ctrl+-') },
  { id: 'reset-zoom', label: shortcut('Actual Size', 'Ctrl+0') },
  separator('view-5'),
  { id: 'toggle-fullscreen', label: shortcut('Toggle Full Screen', 'F11') },
]

const HELP_ITEMS: readonly MenuEntry[] = [
  { id: 'documentation', label: 'Documentation' },
  { id: 'keyboard-shortcuts', label: shortcut('Keyboard Shortcuts', 'Ctrl+/') },
  { id: 'whats-new', label: "What's New" },
  separator('help-1'),
  { id: 'troubleshooting', label: 'Troubleshooting' },
  { id: 'system-status', label: 'System Status' },
  { id: 'send-feedback', label: 'Send Feedback' },
  separator('help-2'),
  { id: 'task-manager', label: 'Task Manager' },
  { id: 'performance-trace', label: 'Start Performance Trace' },
  separator('help-3'),
  { id: 'check-updates', label: 'Check for Updates…' },
  { id: 'about', label: 'About Hydra' },
]

function TitleMenu(props: {
  label: string
  items: readonly MenuEntry[]
  open: boolean
  onOpen: () => void
  onClose: () => void
  onAction: (action: DesktopTitleBarAction) => void
}) {
  return (
    <Menu
      open={props.open}
      anchor={
        <button
          type="button"
          data-hydra-control="action"
          className={css.menuTrigger}
          data-open={props.open || undefined}
          aria-haspopup="menu"
          aria-expanded={props.open}
          onMouseDown={(event) => { event.preventDefault() }}
          onClick={props.onOpen}
        >
          {props.label}
        </button>
      }
      items={props.items}
      onSelect={(id) => { props.onClose(); props.onAction(id as DesktopTitleBarAction) }}
      onClose={props.onClose}
      portal
      dense
    />
  )
}

/** Desktop-only product bar; native window controls remain in Electron's overlay. */
export function DesktopTitleBar({ onAction, canGoBack = false, canGoForward = false, sidebarOpen, children }: DesktopTitleBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const ctrl = event.ctrlKey || event.metaKey
      if (ctrl && event.shiftKey && key === 'b') { event.preventDefault(); onAction('open-browser') }
      else if (ctrl && key === 'n') { event.preventDefault(); onAction('new-chat') }
      else if (ctrl && key === 'o') { event.preventDefault(); onAction('open-folder') }
      else if (ctrl && key === 'b') { event.preventDefault(); onAction('toggle-sidebar') }
      else if (ctrl && key === 'j') { event.preventDefault(); onAction('toggle-bottom-panel') }
      else if (ctrl && event.key === '`') { event.preventDefault(); onAction('open-terminal') }
      else if (event.key === 'F11') { event.preventDefault(); onAction('toggle-fullscreen') }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [onAction])

  const menu = (label: string, items: readonly MenuEntry[]) => (
    <TitleMenu
      key={label}
      label={label}
      items={items}
      open={openMenu === label}
      onOpen={() => { setOpenMenu(openMenu === label ? null : label) }}
      onClose={() => { setOpenMenu(null) }}
      onAction={onAction}
    />
  )

  return (
    <header className={css.bar} data-desktop-titlebar>
      <div className={css.navigation}>
        <Tooltip label="Back" side="bottom">
          <button type="button" data-hydra-control="action" className={css.iconButton} aria-label="Back" disabled={!canGoBack} onClick={() => { onAction('back') }}>
            <IconChevronLeftOutline14 />
          </button>
        </Tooltip>
        <Tooltip label="Forward" side="bottom">
          <button type="button" data-hydra-control="action" className={css.iconButton} aria-label="Forward" disabled={!canGoForward} onClick={() => { onAction('forward') }}>
            <IconChevronRightOutline14 />
          </button>
        </Tooltip>
        <Tooltip label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} side="bottom">
          <button type="button" data-hydra-control="action" className={css.iconButton} aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} aria-pressed={sidebarOpen} onClick={() => { onAction('toggle-sidebar') }}>
            <IconPanelLeftOutline16 />
          </button>
        </Tooltip>
      </div>
      <nav className={css.menus} aria-label="Application menu">
        {menu('File', FILE_ITEMS)}
        {menu('Edit', EDIT_ITEMS)}
        {menu('View', VIEW_ITEMS)}
        {menu('Help', HELP_ITEMS)}
      </nav>
      {children !== undefined && (
        <div className={css.trailing}>
          {children}
        </div>
      )}
    </header>
  )
}
