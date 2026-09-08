// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { DesktopFilesPanel } from '@hydra/harness-client-ui-layout/src/client/DesktopFilesPanel.tsx'
import { DesktopTerminalPanel } from '@hydra/harness-client-ui-layout/src/client/DesktopTerminalPanel.tsx'

const terminalInstances = vi.hoisted(() => [] as Array<{
  options: { theme?: Record<string, string> }
  disposed: boolean
}>)

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: { theme?: Record<string, string> }
    cols = 80
    rows = 24
    disposed = false
    constructor(options: { theme?: Record<string, string> }) {
      this.options = options
      terminalInstances.push(this)
    }
    loadAddon(): void {}
    open(): void {}
    onData(): { dispose(): void } { return { dispose() {} } }
    write(): void {}
    writeln(): void {}
    focus(): void {}
    dispose(): void { this.disposed = true }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}))

function stubObservers(): void {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void { this.callback([], this as unknown as ResizeObserver) }
    disconnect(): void {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
}

afterEach(() => {
  cleanup()
  terminalInstances.length = 0
  document.body.removeAttribute('data-ds-dark-theme')
  document.body.style.removeProperty('--dsw-alias-bg-base')
  document.body.style.removeProperty('--dsw-alias-label-primary')
  delete window.hydraDesktop
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('DesktopTerminalPanel', () => {
  it('serializes starts and keeps restart available after an exit', async () => {
    stubObservers()
    let finishStart!: (state: { running: boolean }) => void
    let onEvent!: (event: { type: 'data'; data: string } | { type: 'exit'; code: number | null }) => void
    const api = {
      start: vi.fn(() => new Promise<{ running: boolean }>((resolve) => { finishStart = resolve })),
      stop: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      onEvent: vi.fn((_id: 'bottom' | 'right', listener: typeof onEvent) => {
        onEvent = listener
        return () => {}
      }),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal: api }

    const view = render(<DesktopTerminalPanel open terminalId="right" embedded />)
    await waitFor(() => { expect(api.start).toHaveBeenCalledOnce() })
    expect(view.getAllByText('Starting…')).toHaveLength(2)
    expect((view.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { finishStart({ running: true }); await Promise.resolve() })
    expect(view.getByText('Running')).toBeTruthy()
    act(() => { onEvent({ type: 'exit', code: 7 }) })
    expect(view.getByText('Exited (7)')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Restart' }))
    await waitFor(() => { expect(api.start).toHaveBeenCalledTimes(2) })
  })

  it('updates xterm colors when the document theme changes and disconnects on cleanup', async () => {
    stubObservers()
    const api = {
      start: vi.fn(async () => ({ running: true })),
      stop: vi.fn(async () => {}),
      write: vi.fn(),
      resize: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, terminal: api }
    document.body.style.setProperty('--dsw-alias-bg-base', '#ffffff')
    document.body.style.setProperty('--dsw-alias-label-primary', '#111111')
    const view = render(
      <>
        <DesktopTerminalPanel open terminalId="bottom" />
        <DesktopTerminalPanel open terminalId="right" embedded />
      </>,
    )
    await waitFor(() => { expect(api.start).toHaveBeenCalledTimes(2) })
    expect(terminalInstances).toHaveLength(2)
    expect(terminalInstances.map(instance => instance.options.theme?.background)).toEqual(['#ffffff', '#ffffff'])
    await act(async () => {
      document.body.style.setProperty('--dsw-alias-bg-base', '#151517')
      document.body.style.setProperty('--dsw-alias-label-primary', '#f4f4f5')
      document.body.setAttribute('data-ds-dark-theme', '')
      await Promise.resolve()
    })
    expect(terminalInstances.map(instance => instance.options.theme?.background)).toEqual(['#151517', '#151517'])
    expect(terminalInstances.map(instance => instance.options.theme?.foreground)).toEqual(['#f4f4f5', '#f4f4f5'])
    expect(terminalInstances).toHaveLength(2)
    expect(terminalInstances.every(instance => !instance.disposed)).toBe(true)
    expect(api.start).toHaveBeenCalledTimes(2)
    expect(api.stop).not.toHaveBeenCalled()
    view.unmount()
    const themesAfterUnmount = terminalInstances.map(instance => instance.options.theme)
    document.body.style.setProperty('--dsw-alias-bg-base', '#ffffff')
    await Promise.resolve()
    terminalInstances.forEach((instance, index) => {
      expect(instance.options.theme).toBe(themesAfterUnmount[index])
    })
  })
})

describe('DesktopFilesPanel', () => {
  it('does not display an old workspace while the new root is loading', async () => {
    const roots = new Map<string, (path: string) => void>()
    const files = {
      root: vi.fn((workspaceId: string) => new Promise<string>((resolve) => { roots.set(workspaceId, resolve) })),
      list: vi.fn(async (path: string) => [{ name: 'file.txt', path: `${path}\\file.txt`, directory: false }]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: '', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const first = 'workspace-first'
    const second = 'workspace-second'
    const view = render(<DesktopFilesPanel workspaceId={first} active focusSearch={1} />)
    await waitFor(() => { expect(files.root).toHaveBeenCalledWith(first) })
    view.rerender(<DesktopFilesPanel workspaceId={second} active focusSearch={1} />)
    await waitFor(() => { expect(files.root).toHaveBeenCalledWith(second) })
    await act(async () => { roots.get(first)?.('C:\\first'); await Promise.resolve() })
    expect(view.queryByRole('tree', { name: 'Workspace files' })).toBeNull()
    await act(async () => { roots.get(second)?.('C:\\second'); await Promise.resolve() })
    expect(await view.findByRole('tree', { name: 'Workspace files' })).toBeTruthy()
    expect(within(view.getByRole('tree', { name: 'Workspace files' })).getByRole('button', { name: 'file.txt' })).toBeTruthy()
  })

  it('prevents duplicate create requests from rapid submits', async () => {
    const rootPath = 'C:\\workspace'
    let finishCreate!: (entry: { name: string; path: string; directory: boolean }) => void
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: '', version: 'v1' })),
      create: vi.fn(() => new Promise<{ name: string; path: string; directory: boolean }>((resolve) => { finishCreate = resolve })),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })
    fireEvent.click(view.getByRole('button', { name: 'New file' }))
    const input = view.getByRole('textbox', { name: 'New file name' })
    fireEvent.change(input, { target: { value: 'new.ts' } })
    const form = input.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(files.create).toHaveBeenCalledOnce()
    await act(async () => {
      finishCreate({ name: 'new.ts', path: `${rootPath}\\new.ts`, directory: false })
      await Promise.resolve()
    })
  })

  it('ignores an older directory request after a newer refresh starts', async () => {
    const rootPath = 'C:\\workspace'
    const listRequests: Array<{ resolve: (entries: Array<{ name: string; path: string; directory: boolean }>) => void }> = []
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(() => new Promise<Array<{ name: string; path: string; directory: boolean }>>((resolve) => {
        listRequests.push({ resolve })
      })),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: '', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await waitFor(() => { expect(files.list).toHaveBeenCalledOnce() })
    await act(async () => {
      listRequests[0]?.resolve([{ name: 'initial.txt', path: `${rootPath}\\initial.txt`, directory: false }])
      await Promise.resolve()
    })
    expect(view.getByRole('button', { name: 'initial.txt' })).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: 'Refresh files' }))
    fireEvent.click(view.getByRole('button', { name: 'Refresh files' }))
    expect(files.list).toHaveBeenCalledTimes(3)
    await act(async () => {
      listRequests[2]?.resolve([{ name: 'newest.txt', path: `${rootPath}\\newest.txt`, directory: false }])
      await Promise.resolve()
    })
    fireEvent.click(view.getByRole('button', { name: 'Refresh files' }))
    expect(files.list).toHaveBeenCalledTimes(4)
    await act(async () => {
      listRequests[1]?.resolve([{ name: 'old.txt', path: `${rootPath}\\old.txt`, directory: false }])
      await Promise.resolve()
    })
    expect(view.getByRole('button', { name: 'newest.txt' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'old.txt' })).toBeNull()

    await act(async () => {
      listRequests[3]?.resolve([{ name: 'current.txt', path: `${rootPath}\\current.txt`, directory: false }])
      await Promise.resolve()
    })
    expect(view.getByRole('button', { name: 'current.txt' })).toBeTruthy()
    expect(view.queryByRole('button', { name: 'newest.txt' })).toBeNull()
  })

  it('supports multi-document tabs, switching tabs, and closing tabs', async () => {
    const rootPath = 'C:\\workspace'
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [
        { name: 'a.ts', path: `${rootPath}\\a.ts`, directory: false },
        { name: 'b.ts', path: `${rootPath}\\b.ts`, directory: false },
      ]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: `content of ${path}`, version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })

    // Open first file
    fireEvent.click(view.getByRole('button', { name: 'a.ts' }))
    await view.findByRole('textbox', { name: 'Editor for a.ts' })
    expect(view.getByRole('tab', { name: /a\.ts/ })).toBeTruthy()

    // Open second file
    fireEvent.click(view.getByRole('button', { name: 'b.ts' }))
    await view.findByRole('textbox', { name: 'Editor for b.ts' })
    expect(view.getByRole('tab', { name: /a\.ts/ })).toBeTruthy()
    expect(view.getByRole('tab', { name: /b\.ts/ })).toBeTruthy()

    // Switch back to first file tab
    fireEvent.click(view.getByRole('tab', { name: /a\.ts/ }))
    expect(await view.findByRole('textbox', { name: 'Editor for a.ts' })).toBeTruthy()

    // Close tab
    fireEvent.click(view.getByRole('button', { name: 'Close a.ts' }))
    expect(view.queryByRole('tab', { name: /a\.ts/ })).toBeNull()
    expect(view.getByRole('tab', { name: /b\.ts/ })).toBeTruthy()
  })

  it('supports context menu actions: rename and delete files', async () => {
    const rootPath = 'C:\\workspace'
    const renameFn = vi.fn(async (_path: string, newName: string) => ({
      oldPath: `${rootPath}\\old.ts`,
      path: `${rootPath}\\${newName}`,
      name: newName,
      directory: false,
    }))
    const deleteFn = vi.fn(async (path: string) => ({ path }))
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: 'old.ts', path: `${rootPath}\\old.ts`, directory: false }]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: 'code', version: 'v1' })),
      create: vi.fn(),
      rename: renameFn,
      delete: deleteFn,
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })

    const fileButton = view.getByRole('button', { name: 'old.ts' })
    // Right click to open context menu
    fireEvent.contextMenu(fileButton)
    expect(view.getByRole('menu', { name: 'File options' })).toBeTruthy()

    // Click Rename
    fireEvent.click(view.getByRole('menuitem', { name: 'Rename' }))
    const renameInput = view.getByRole('textbox', { name: 'Rename old.ts' })
    fireEvent.change(renameInput, { target: { value: 'renamed.ts' } })
    fireEvent.click(view.getByRole('button', { name: 'Confirm rename' }))
    await waitFor(() => {
      expect(renameFn).toHaveBeenCalledWith(`${rootPath}\\old.ts`, 'renamed.ts', 'workspace')
    })

    // Delete with confirmation
    const updatedButton = await view.findByRole('button', { name: 'old.ts' })
    fireEvent.contextMenu(updatedButton)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(view.getByRole('menuitem', { name: 'Delete' }))
    await waitFor(() => {
      expect(deleteFn).toHaveBeenCalledWith(`${rootPath}\\old.ts`, 'workspace')
    })
    confirmSpy.mockRestore()
  })

  it('renders line numbers gutter and supports discard of unsaved changes', async () => {
    const rootPath = 'C:\\workspace'
    const files = {
      root: vi.fn(async () => rootPath),
      list: vi.fn(async () => [{ name: 'file.ts', path: `${rootPath}\\file.ts`, directory: false }]),
      search: vi.fn(async () => []),
      read: vi.fn(async (path: string) => ({ path, content: 'line 1\nline 2\nline 3', version: 'v1' })),
      create: vi.fn(),
      save: vi.fn(),
      format: vi.fn(),
    }
    window.hydraDesktop = { browser: { setBounds: vi.fn() }, files }
    const view = render(<DesktopFilesPanel workspaceId="workspace" active focusSearch={1} />)
    await view.findByRole('tree', { name: 'Workspace files' })
    fireEvent.click(view.getByRole('button', { name: 'file.ts' }))

    const editor = await view.findByRole('textbox', { name: 'Editor for file.ts' }) as HTMLTextAreaElement
    expect(editor.value).toBe('line 1\nline 2\nline 3')
    expect(view.getByText('3 lines')).toBeTruthy()

    // Edit content to be 4 lines
    fireEvent.change(editor, { target: { value: 'line 1\nline 2\nline 3\nline 4' } })
    expect(view.getByText('4 lines')).toBeTruthy()
    expect(view.getByRole('button', { name: 'Discard' })).toBeTruthy()

    // Discard changes
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(view.getByRole('button', { name: 'Discard' }))
    expect(editor.value).toBe('line 1\nline 2\nline 3')
    expect(view.getByText('3 lines')).toBeTruthy()
    confirmSpy.mockRestore()
  })
})
