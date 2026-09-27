// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, stubSettingsScope, type StubSettingsScope } from '@hydra/harness-client-test-runtime'
import { createSnapshotStore } from '@hydra/harness-client-runtime/client'
import type { PluginInventorySnapshot } from '@hydra/harness-api-remotes/client'
import { McpSettingsTab, type McpSettingsTabProps } from '../src/client/McpSettingsTab.tsx'
import {
  MCP_API_KEY_REF,
  McpSettingsController,
  type McpSettings,
  type McpSettingsState,
} from '../src/client/mcp-settings-controller.ts'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: keyof typeof en) => en[key]) as McpSettingsTabProps['t']

function field(text = ''): CardFieldState {
  return { text, overridden: false, invalid: false }
}

const settled: CardShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

function acceptWrites(host: StubSettingsScope<McpSettings>): void {
  host.set.mockImplementation((name: string, value: unknown) => {
    host.publish({ value: { ...host.scope.getSnapshot().value, [name]: value }, user: { [name]: value } })
  })
}

function credentialApi(configured = false) {
  let hasKey = configured
  const describe = vi.fn(() => {
    const credentials: Record<string, { configured: boolean; writable: boolean }> = {
      [MCP_API_KEY_REF]: { configured: hasKey, writable: true },
    }
    return Promise.resolve({
      rpcId: 'mcp-read' as never,
      result: {
        ok: true as const,
        value: { credentials },
      },
    })
  })
  const set = vi.fn(() => {
    hasKey = true
    return Promise.resolve({ rpcId: 'mcp-write' as never, result: { ok: true as const, value: {} } })
  })
  return { api: { credentials: { describe, set } } as never, describe, set }
}

function renderTab(
  state: Partial<McpSettingsState> = {},
  importedMcp?: McpSettingsTabProps['importedMcp'],
  nativeMcp?: McpSettingsTabProps['nativeMcp'],
  query = '',
  overrides: Partial<McpSettingsTabProps> = {},
) {
  const store = createSnapshotStore<McpSettingsState>({
    ...settled,
    apiKey: field(),
    apiKeyConfigured: false,
    apiKeyWritable: true,
    ...state,
  })
  const actions = { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
  render(<McpSettingsTab {...{
    active: true,
    ...actions,
    t,
    query,
    useMcpSettings: bindSnapshotSelector(store),
    ...(importedMcp === undefined ? {} : { importedMcp }),
    ...(nativeMcp === undefined ? {} : { nativeMcp }),
    ...overrides,
  } as unknown as McpSettingsTabProps} />)
  return actions
}

describe('McpSettingsController', () => {
  it('treats an absent credential entry as writable and unconfigured', async () => {
    const host = stubSettingsScope<McpSettings>()
    const credentials = credentialApi(true)
    const controller = new McpSettingsController(host.scope, credentials.api)
    const store = controller.inject().hooks.mcpSettings
    await vi.waitFor(() => { expect(store.getSnapshot().apiKeyConfigured).toBe(true) })
    credentials.describe.mockResolvedValueOnce({
      rpcId: 'mcp-read' as never, result: { ok: true, value: { credentials: {} } },
    })
    controller.refreshCredential(MCP_API_KEY_REF)
    await vi.waitFor(() => { expect(store.getSnapshot()).toMatchObject({ apiKeyConfigured: false, apiKeyWritable: true }) })
  })
  it.each(['rejected', 'error-result'])('retains a failed key rotation even when an older key exists: %s', async (failure) => {
    const host = stubSettingsScope<McpSettings>()
    const credentials = credentialApi(true)
    const set = vi.fn(async () => {
      if (failure === 'rejected') throw new Error('write refused')
      return { rpcId: 'write', result: { ok: false, error: { code: 'unavailable', message: 'write refused' } } }
    })
    const controller = new McpSettingsController(host.scope, {
      credentials: { describe: credentials.describe, set },
    } as never)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()
    await vi.waitFor(() => { expect(face.hooks.mcpSettings.getSnapshot().apiKeyConfigured).toBe(true) })
    face.edit('apiKey', 'replacement')
    face.save()
    await vi.waitFor(() => {
      expect(face.hooks.mcpSettings.getSnapshot()).toMatchObject({ failed: true, dirty: true, apiKey: { text: 'replacement' } })
    })
  })
  it('saves the fixed Obsidian credential through its owning store', async () => {
    const host = stubSettingsScope<McpSettings>()
    acceptWrites(host)
    const credentials = credentialApi()
    const controller = new McpSettingsController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', ' secret ')
    face.save()

    await vi.waitFor(() => { expect(credentials.set).toHaveBeenCalledWith({ ref: MCP_API_KEY_REF, value: 'secret' }) })
    await vi.waitFor(() => {
      expect(face.hooks.mcpSettings.getSnapshot()).toMatchObject({
        dirty: false,
        apiKeyConfigured: true,
      })
    })
  })

  it('accepts a credential write when status read-back is unavailable', async () => {
    const host = stubSettingsScope<McpSettings>()
    const credentials = credentialApi()
    credentials.describe.mockImplementationOnce(credentials.describe.getMockImplementation()!)
      .mockRejectedValueOnce(new Error('offline'))
    const controller = new McpSettingsController(host.scope, credentials.api)
    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', 'secret')
    face.save()

    await vi.waitFor(() => {
      expect(credentials.set).toHaveBeenCalledWith({ ref: MCP_API_KEY_REF, value: 'secret' })
      expect(face.hooks.mcpSettings.getSnapshot()).toMatchObject({ dirty: false, failed: false })
    })
  })

  it('refreshes only the Obsidian credential and keeps read failures non-blocking', async () => {
    const host = stubSettingsScope<McpSettings>()
    const credentials = credentialApi(true)
    const controller = new McpSettingsController(host.scope, credentials.api)
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalled() })
    credentials.describe.mockClear()

    controller.refreshCredential('OTHER_KEY')
    expect(credentials.describe).not.toHaveBeenCalled()
    controller.refreshCredential(MCP_API_KEY_REF)
    await vi.waitFor(() => { expect(credentials.describe).toHaveBeenCalledOnce() })

    const failing = new McpSettingsController(host.scope, {
      credentials: { describe: vi.fn(() => Promise.reject(new Error('offline'))), set: vi.fn() },
    } as never)
    await Promise.resolve()
    expect(failing.inject().hooks.mcpSettings.getSnapshot().apiKeyConfigured).toBe(false)
  })

  it('keeps a rejected credential draft for correction', async () => {
    const host = stubSettingsScope<McpSettings>()
    const describe = vi.fn(() => Promise.resolve({
      rpcId: 'mcp-read' as never,
      result: { ok: false as const, error: { code: 'unavailable', message: 'offline' } },
    }))
    const set = vi.fn(() => Promise.reject(new Error('read-only')))
    const controller = new McpSettingsController(host.scope, { credentials: { describe, set } } as never)
    host.publish({ status: 'ready', writable: true, value: {}, user: {} })
    const face = controller.inject()

    face.edit('apiKey', 'secret')
    face.save()

    await vi.waitFor(() => {
      expect(face.hooks.mcpSettings.getSnapshot()).toMatchObject({ dirty: true, failed: true })
    })
  })
})

describe('McpSettingsTab', () => {
  it.each([false, true])('ignores native and imported replies after unmount (reject: %s)', async (reject) => {
    const pending = Promise.withResolvers<undefined>()
    const imported = { list: vi.fn(async () => { await pending.promise; return { plugins: [] } }), setEnabled: vi.fn() }
    const native = { list: vi.fn(async () => { await pending.promise; return { entries: [] } }) }
    renderTab({}, imported, native, '', { active: false })
    expect(imported.list).not.toHaveBeenCalled()
    expect(native.list).not.toHaveBeenCalled()
    cleanup()
    renderTab({}, imported, native)
    cleanup()
    await act(async () => { if (reject) pending.reject(new Error('offline')); else pending.resolve(undefined) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['not-started', 'mcpServerNotStarted'], ['starting', 'mcpServerStarting'], ['failed', 'mcpServerFailed'],
  ] as const)('shows imported server state %s and refreshes after a failed toggle', async (status, label) => {
    const snapshot = { plugins: [{ identity: 'tools', name: 'Tools', mcpServers: [
      { name: 'server', enabled: true, startupState: status }, { name: 'off', enabled: false, startupState: 'not-started' },
    ] }] } as never
    const list = vi.fn(async () => snapshot)
    renderTab({}, { list, setEnabled: vi.fn(async () => { throw new Error('refused') }) })
    await screen.findByText(en[label])
    fireEvent.click(screen.getByRole('switch', { name: `${en.enable} off` }))
    await screen.findByText(en.mcpToggleFailed)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('includes the user server catalog when its controls are available', async () => {
    renderTab({ available: false }, undefined, undefined, '', { userMcp: {
      list: async () => ({ servers: [] }), define: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(),
    } })
    expect(await screen.findByText(en.userMcpEmpty)).not.toBeNull()
  })

  it.each(['native', 'imported'] as const)('offers retry when the %s MCP inventory cannot load', async (kind) => {
    const list = vi.fn(async () => { throw new Error('offline') })
    const controls = { list, setEnabled: vi.fn() }
    renderTab({ available: false }, kind === 'imported' ? controls : undefined, kind === 'native' ? controls : undefined)
    expect((await screen.findByRole('alert')).textContent).toBe(en.mcpLoadError)
    expect(screen.queryByText(en.mcpLoading)).toBeNull()
    list.mockImplementationOnce(async () => (kind === 'imported' ? { plugins: [] } : { entries: [] }) as never)
    fireEvent.click(screen.getByRole('button', { name: en.mcpRetry }))
    await vi.waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(list).toHaveBeenCalledTimes(2)
  })
  it('shows why the tab has no controls when the plugin is unavailable', () => {
    renderTab({ available: false })

    expect(screen.getByText(en.mcpUnavailable)).toBeTruthy()
    expect(screen.queryByText(en.mcpTitle)).toBeNull()
  })

  it('stages the secret without exposing the stored key', () => {
    const actions = renderTab({
      apiKeyConfigured: true,
    })
    fireEvent.click(screen.getByText(en.mcpTitle))

    const key = screen.getByLabelText(en.mcpApiKey)
    expect(key).toHaveProperty('type', 'password')
    expect(screen.getByText(en.mcpApiKeySet)).toBeTruthy()
    fireEvent.change(key, { target: { value: 'secret' } })

    expect(actions.edit.mock.calls).toEqual([['apiKey', 'secret']])
  })

  it('uses the owning store to disable the control it owns', () => {
    renderTab({ writable: false, apiKeyWritable: false })
    fireEvent.click(screen.getByText(en.mcpTitle))

    expect(screen.getByLabelText(en.mcpApiKey)).toHaveProperty('disabled', true)
    expect(screen.getByText(en.mcpApiKeyUnset)).toBeTruthy()
  })

  it('lists and switches imported plugin MCP servers in the MCP tab', async () => {
    const snapshot = {
      plugins: [{
        identity: 'toolkit@local', name: 'Toolkit', version: '4.9.0', enabled: true,
        mcpServers: [{ name: 'toolkit-mcp', enabled: true, startupState: 'started' }],
      }],
    } as never
    const setEnabled = vi.fn(async () => snapshot)
    renderTab({}, { list: vi.fn(async () => snapshot), setEnabled })

    expect(await screen.findByText('toolkit-mcp')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: `${en.disable} toolkit-mcp` }))
    await vi.waitFor(() => { expect(setEnabled).toHaveBeenCalledWith('toolkit@local', 'toolkit-mcp', false) })
  })

  it('edits per-tool approval for an imported MCP server', async () => {
    const tool = 'mcp__toolkit@local__read'
    const snapshot = {
      plugins: [{
        identity: 'toolkit@local', name: 'Toolkit', version: '4.9.0', enabled: true,
        mcpServers: [{
          name: 'toolkit-mcp', enabled: true, startupState: 'started',
          authenticationState: 'not-applicable', defaultToolsApprovalMode: 'ask', toolApproval: {}, tools: [tool],
        }],
      }],
    } as never
    const setToolApproval = vi.fn(async () => snapshot)
    renderTab({}, {
      list: vi.fn(async () => snapshot),
      setEnabled: vi.fn(),
      setToolApproval,
    })

    const approval = await screen.findByRole('combobox', { name: `${en.mcpToolApproval} ${tool}` })
    fireEvent.change(approval, { target: { value: 'deny' } })
    await vi.waitFor(() => {
      expect(setToolApproval).toHaveBeenCalledWith('toolkit@local', 'toolkit-mcp', tool, 'deny')
    })
  })

  it('filters imported MCP server rows by the shared search query', async () => {
    const snapshot = {
      plugins: [{
        identity: 'toolkit@local', name: 'Toolkit', version: '4.9.0', enabled: true,
        mcpServers: [{ name: 'toolkit-mcp', enabled: true, startupState: 'started' }],
      }],
    } as never
    renderTab({}, { list: vi.fn(async () => snapshot), setEnabled: vi.fn() }, undefined, 'no-match')

    expect(await screen.findByText(en.importedMcpEmptySearch)).toBeTruthy()
    expect(screen.queryByText('toolkit-mcp')).toBeNull()
  })

  it('hides the unavailable native MCP fallback section when the query does not match it', async () => {
    const entry: PluginInventorySnapshot['entries'][number] = {
      entryId: 'obsidian-knowledge' as never, moduleName: '@hydra/harness-obsidian-knowledge',
      enabled: false, restartRequired: false, toggleable: true, fiberPhase: null,
    }
    renderTab({ available: false }, undefined, { list: vi.fn(async () => ({ entries: [entry] })) }, 'no-match')

    await vi.waitFor(() => { expect(screen.queryByText(en.mcpUnavailable)).toBeNull() })
  })

  it('reports the native Obsidian MCP plugin without mutating it', async () => {
    const entry: PluginInventorySnapshot['entries'][number] = {
      entryId: 'obsidian-knowledge' as never, moduleName: '@hydra/harness-obsidian-knowledge',
      enabled: true, restartRequired: false, toggleable: true, fiberPhase: 'active',
    }
    const enabled: PluginInventorySnapshot = { entries: [entry] }
    renderTab({}, undefined, { list: vi.fn(async () => enabled) })

    fireEvent.click(screen.getByText(en.mcpTitle))
    expect(await screen.findByText(en.mcpEnabled)).toBeTruthy()
  })

  it.each([true, false])('finds the native MCP plugin by module name with enabled=%s', async (enabled) => {
    const entry: PluginInventorySnapshot['entries'][number] = {
      entryId: 'obsidian-knowledge' as never, moduleName: '@hydra/harness-obsidian-knowledge',
      enabled, restartRequired: false, toggleable: true, fiberPhase: enabled ? 'active' : null,
    }
    renderTab({ available: enabled }, undefined, {
      list: vi.fn(async () => ({ entries: [entry] })),
    }, 'kno')

    const status = await screen.findByText(enabled ? en.mcpEnabled : en.disabled)
    expect(status).toBeTruthy()
  })

  it('keeps the Obsidian credential editable while the plugin is disabled', async () => {
    const entry: PluginInventorySnapshot['entries'][number] = {
      entryId: 'obsidian-knowledge' as never, moduleName: '@hydra/harness-obsidian-knowledge',
      enabled: false, restartRequired: false, toggleable: true, fiberPhase: null,
    }
    const actions = renderTab({ available: false }, undefined, {
      list: vi.fn(async () => ({ entries: [entry] })),
    })

    await screen.findByText(en.disabled)
    fireEvent.click(screen.getByText(en.mcpTitle))
    const key = screen.getByLabelText(en.mcpApiKey)
    expect(key).toHaveProperty('disabled', false)
    fireEvent.change(key, { target: { value: 'replacement' } })
    expect(actions.edit).toHaveBeenCalledWith('apiKey', 'replacement')
  })
})
