// @vitest-environment jsdom
import { useState } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { SessionId } from '@bosch/bh-client-runtime/client'
import {
  DesktopBrowserPanel,
  DesktopPanelControls,
} from '@bosch/bh-client-ui-layout/src/client/DesktopBrowserPanel.tsx'
import type { DesktopBrowserApi } from '@bosch/bh-client-ui-layout/src/client/DesktopBrowserPanel.tsx'

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }))

function PanelHarness(props: {
  open?: boolean | undefined
  createSideSession: () => Promise<SessionId>
  renderSideChat: (sessionId: SessionId) => ReactNode
  onOpen?: (() => void) | undefined
}) {
  const [chooserOpen, setChooserOpen] = useState(false)
  return (
    <DesktopBrowserPanel
      open={props.open ?? true}
      chooserOpen={chooserOpen}
      createSideSession={props.createSideSession}
      renderSideChat={props.renderSideChat}
      onCloseChooser={() => { setChooserOpen(false) }}
      onToggleChooser={() => { setChooserOpen(open => !open) }}
      onOpen={props.onOpen ?? (() => {})}
    />
  )
}

function stubPanelObservers(): void {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void { this.callback([], this as unknown as ResizeObserver) }
    disconnect(): void {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => { callback(0) }, 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { window.clearTimeout(id) })
}

afterEach(() => {
  cleanup()
  delete window.bhDesktop
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DesktopBrowserPanel', () => {
  it('hides native bounds for overlays and non-Browser tabs, then restores them', async () => {
    const setBounds = vi.fn()
    const api: DesktopBrowserApi = { setBounds }
    window.bhDesktop = { browser: api }
    stubPanelObservers()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 700, y: 72, left: 700, top: 72, right: 1200, bottom: 800,
      width: 500, height: 728, toJSON: () => ({}),
    })

    const createSideSession = vi.fn(async () => 'side-1' as SessionId)
    const renderSideChat = (sessionId: SessionId) => <div>{String(sessionId)}</div>
    const view = render(
      <PanelHarness createSideSession={createSideSession} renderSideChat={renderSideChat} />,
    )
    const visibleBounds = { x: 700, y: 72, width: 500, height: 728, visible: true }
    const hiddenBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }

    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(visibleBounds) })

    fireEvent.click(view.getByRole('button', { name: 'Choose panel' }))
    await waitFor(() => {
      expect(setBounds).toHaveBeenLastCalledWith({ ...visibleBounds, visible: false })
    })
    fireEvent.keyDown(view.getByRole('dialog', { name: 'Choose panel' }), { key: 'Escape' })
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(visibleBounds) })

    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    document.body.append(modal)
    await waitFor(() => {
      expect(setBounds).toHaveBeenLastCalledWith({ ...visibleBounds, visible: false })
    })
    modal.remove()
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(visibleBounds) })

    fireEvent.click(view.getByRole('button', { name: 'Choose panel' }))
    fireEvent.click(within(view.getByRole('dialog', { name: 'Choose panel' })).getByRole('button', { name: 'Files' }))
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(hiddenBounds) })

    fireEvent.click(view.getByRole('tab', { name: 'Browser' }))
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(visibleBounds) })

    view.rerender(
      <PanelHarness open={false} createSideSession={createSideSession} renderSideChat={renderSideChat} />,
    )
    await waitFor(() => { expect(setBounds).toHaveBeenLastCalledWith(hiddenBounds) })
  })

  it('opens Files, multiple Side chat sessions, Browser, and a right Terminal as tabs', async () => {
    const rootPath = 'C:\\workspace'
    const sourcePath = `${rootPath}\\src`
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async (path?: string) => path === sourcePath
        ? [{ name: 'index.ts', path: `${sourcePath}\\index.ts`, directory: false }]
        : [
          { name: 'src', path: sourcePath, directory: true },
          { name: 'README.md', path: `${rootPath}\\README.md`, directory: false },
        ]),
      read: vi.fn(async (path: string) => ({ path, content: 'fixture' })),
    }
    window.bhDesktop = { browser: { setBounds: vi.fn() }, files }
    stubPanelObservers()
    const sessionIds = ['side-1', 'side-2'] as SessionId[]
    let nextSession = 0
    const createSideSession = vi.fn(async () => sessionIds[nextSession++]!)
    const renderSideChat = (sessionId: SessionId) => <div>{`Chat ${String(sessionId)}`}</div>
    const onOpen = vi.fn()
    const view = render(
      <PanelHarness
        createSideSession={createSideSession}
        renderSideChat={renderSideChat}
        onOpen={onOpen}
      />,
    )
    const choose = (name: 'Files' | 'Side chat' | 'Terminal') => {
      fireEvent.click(view.getByRole('button', { name: 'Choose panel' }))
      const dialog = view.getByRole('dialog', { name: 'Choose panel' })
      fireEvent.click(within(dialog).getByRole('button', { name }))
    }

    expect(view.getByRole('tab', { name: 'Browser' }).getAttribute('aria-selected')).toBe('true')
    choose('Files')
    expect(view.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true')
    const tree = await view.findByRole('tree', { name: 'Workspace files' })
    expect(files.root).toHaveBeenCalledOnce()
    expect(files.list).toHaveBeenCalledWith(rootPath)
    fireEvent.click(within(tree).getByRole('button', { name: 'src' }))
    await waitFor(() => { expect(files.list).toHaveBeenCalledWith(sourcePath) })
    expect(within(tree).getByRole('button', { name: 'index.ts' })).toBeTruthy()

    choose('Side chat')
    await waitFor(() => { expect(view.getByRole('tab', { name: 'Side chat' })).toBeTruthy() })
    choose('Side chat')
    await waitFor(() => { expect(view.getByRole('tab', { name: 'Side chat 2' })).toBeTruthy() })

    choose('Terminal')
    expect(view.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      'Browser', 'Files', 'Side chat', 'Side chat 2', 'Terminal',
    ])
    expect(view.getByLabelText('Right terminal').getAttribute('data-desktop-panel')).toBe('right-terminal')
    expect(view.getByText('Chat side-1')).toBeTruthy()
    expect(view.getByText('Chat side-2')).toBeTruthy()
    expect(createSideSession).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenCalledTimes(4)
  })

  it('uses the current labels and pressed state for independent desktop controls', () => {
    const onToggleBrowser = vi.fn()
    const onToggleTerminal = vi.fn()
    const onToggleExpanded = vi.fn()
    const view = render(
      <DesktopPanelControls
        browserOpen
        terminalOpen
        browserExpanded={false}
        onToggleBrowser={onToggleBrowser}
        onToggleTerminal={onToggleTerminal}
        onToggleExpanded={onToggleExpanded}
      />,
    )
    expect(view.getByLabelText('Toggle right panel').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByLabelText('Toggle bottom terminal').getAttribute('aria-pressed')).toBe('true')
    expect(view.getByLabelText('Expand right panel').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(view.getByLabelText('Toggle right panel'))
    fireEvent.click(view.getByLabelText('Toggle bottom terminal'))
    fireEvent.click(view.getByLabelText('Expand right panel'))
    expect(onToggleBrowser).toHaveBeenCalledOnce()
    expect(onToggleTerminal).toHaveBeenCalledOnce()
    expect(onToggleExpanded).toHaveBeenCalledOnce()
  })
})
