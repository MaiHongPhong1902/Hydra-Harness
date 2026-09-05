// @vitest-environment jsdom
/**
 * The user's own MCP records as the Plugins MCP tab renders them: what a save
 * sends, what an edit withholds, and what each live state reads as.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { McpServerSnapshot } from '@bosch/bh-api-remotes/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServerCatalog, type UserMcpControls } from '../src/client/McpServerCatalog.tsx'
import { en, type PluginsSettingsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: PluginsSettingsLocaleKey): string => en[key]

const EMPTY: McpServerSnapshot = { servers: [] }
const STORED: McpServerSnapshot = {
  servers: [{
    name: 'notes',
    transport: 'stdio',
    enabled: false,
    status: 'stopped',
    command: 'node',
    args: ['server.js'],
    envNames: ['NOTES_TOKEN'],
    headerNames: [],
    toolCallTimeoutMs: 60_000,
    tools: [],
  }],
}
const RUNNING: McpServerSnapshot = {
  servers: [{ ...STORED.servers[0]!, enabled: true, status: 'started', tools: ['mcp__notes__read'] }],
}

function controls(overrides: Partial<UserMcpControls> = {}): UserMcpControls {
  return {
    list: vi.fn(async () => EMPTY),
    define: vi.fn(async () => STORED),
    setEnabled: vi.fn(async () => RUNNING),
    remove: vi.fn(async () => EMPTY),
    ...overrides,
  }
}

describe('McpServerCatalog', () => {
  it('saves a stdio server with its arguments and environment', async () => {
    const face = controls()
    render(<McpServerCatalog controls={face} query="" t={t} />)

    await screen.findByText(en.userMcpEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.userMcpAdd }))
    const dialog = screen.getByRole('dialog', { name: en.userMcpAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpName }), { target: { value: ' notes ' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpCommand }), { target: { value: ' node ' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpArgs }), {
      target: { value: ' server.js \n\n --port=0 ' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpEnv }), {
      target: { value: ' NOTES_TOKEN=abc123 ' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: en.userMcpSave }))

    await waitFor(() => {
      expect(face.define).toHaveBeenCalledWith({
        name: 'notes',
        transport: 'stdio',
        command: 'node',
        args: ['server.js', '--port=0'],
        cwd: '',
        env: { NOTES_TOKEN: 'abc123' },
      })
    })
    expect(await screen.findByText('notes')).toBeTruthy()
  })

  it('saves a remote server with its headers', async () => {
    const face = controls()
    render(<McpServerCatalog controls={face} query="" t={t} />)

    await screen.findByText(en.userMcpEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.userMcpAdd }))
    const dialog = screen.getByRole('dialog', { name: en.userMcpAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpName }), { target: { value: 'remote' } })
    fireEvent.change(within(dialog).getByRole('combobox', { name: en.userMcpTransport }), {
      target: { value: 'streamable-http' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpUrl }), {
      target: { value: 'https://mcp.example.test/v1' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpHeaders }), {
      target: { value: 'Authorization=Bearer token' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: en.userMcpSave }))

    await waitFor(() => {
      expect(face.define).toHaveBeenCalledWith({
        name: 'remote',
        transport: 'streamable-http',
        url: 'https://mcp.example.test/v1',
        headers: { Authorization: 'Bearer token' },
      })
    })
  })

  it('omits a blank credential map on an edit, so the stored value survives', async () => {
    const face = controls({ list: vi.fn(async () => STORED) })
    render(<McpServerCatalog controls={face} query="" t={t} />)

    fireEvent.click(await screen.findByRole('button', { name: en.userMcpEdit }))
    const dialog = screen.getByRole('dialog', { name: en.userMcpEditTitle })
    // The record's env names are shown, but never its values.
    expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: en.userMcpEnv }).value).toBe('')
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: en.userMcpName }).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: en.userMcpSave }))

    await waitFor(() => { expect(face.define).toHaveBeenCalledTimes(1) })
    expect(vi.mocked(face.define).mock.calls[0]?.[0]).not.toHaveProperty('env')
  })

  it('blocks the save when an assignment line carries no name', async () => {
    const face = controls()
    render(<McpServerCatalog controls={face} query="" t={t} />)

    await screen.findByText(en.userMcpEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.userMcpAdd }))
    const dialog = screen.getByRole('dialog', { name: en.userMcpAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpName }), { target: { value: 'notes' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpCommand }), { target: { value: 'node' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpEnv }), { target: { value: '=orphan' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.userMcpSave }))

    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.userMcpEnvInvalid)
    expect(face.define).not.toHaveBeenCalled()
  })

  it('reports a refused save without closing the dialog', async () => {
    const face = controls({ define: vi.fn(async () => { throw new Error('refused') }) })
    render(<McpServerCatalog controls={face} query="" t={t} />)

    await screen.findByText(en.userMcpEmpty)
    fireEvent.click(screen.getByRole('button', { name: en.userMcpAdd }))
    const dialog = screen.getByRole('dialog', { name: en.userMcpAddTitle })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpName }), { target: { value: 'notes' } })
    fireEvent.change(within(dialog).getByRole('textbox', { name: en.userMcpCommand }), { target: { value: 'node' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.userMcpSave }))

    expect((await within(dialog).findByRole('alert')).textContent).toBe(en.userMcpSaveError)
    expect(screen.getByRole('dialog', { name: en.userMcpAddTitle })).toBeTruthy()
  })

  it('toggles and removes one record through its controls', async () => {
    const face = controls({ list: vi.fn(async () => STORED) })
    render(<McpServerCatalog controls={face} query="" t={t} />)

    fireEvent.click(await screen.findByRole('switch', { name: `${en.enable} notes` }))
    await waitFor(() => { expect(face.setEnabled).toHaveBeenCalledWith('notes', true) })
    expect(await screen.findByText(en.userMcpStarted)).toBeTruthy()
    expect(screen.getByText(`${en.userMcpTools}: mcp__notes__read`)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.userMcpRemove }))
    await waitFor(() => { expect(face.remove).toHaveBeenCalledWith('notes') })
    expect(await screen.findByText(en.userMcpEmpty)).toBeTruthy()
  })

  it('shows the refusal reason for a record the Host will not mount', async () => {
    const invalid: McpServerSnapshot = {
      servers: [{
        ...STORED.servers[0]!,
        enabled: true,
        status: 'invalid',
        detail: 'mcpServers: stdio server notes requires a command',
      }],
    }
    render(<McpServerCatalog controls={controls({ list: vi.fn(async () => invalid) })} query="" t={t} />)

    expect(await screen.findByText(en.userMcpInvalid)).toBeTruthy()
    expect(screen.getByText('mcpServers: stdio server notes requires a command')).toBeTruthy()
  })

  it('filters by the section query and reports a load failure', async () => {
    const { rerender } = render(<McpServerCatalog controls={controls({ list: vi.fn(async () => STORED) })} query="" t={t} />)
    expect(await screen.findByText('notes')).toBeTruthy()

    rerender(<McpServerCatalog controls={controls({ list: vi.fn(async () => STORED) })} query="absent" t={t} />)
    expect(await screen.findByText(en.userMcpEmptySearch)).toBeTruthy()

    cleanup()
    render(<McpServerCatalog controls={controls({ list: vi.fn(async () => { throw new Error('down') }) })} query="" t={t} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.userMcpLoadError)
  })
})
