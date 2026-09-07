/**
 * Settings-backed MCP record storage and mount reconciliation. The MCP SDK is
 * mocked so a mount is observable without a real server process; what the
 * document holds is asserted against the file on disk.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@hydra/cordis'
import SystemPrompt from '@hydra/harness-system-prompt'
import ToolRuntime from '@hydra/harness-tools'
import FileSettingsProvider from '@hydra/harness-settings-file'
import { SettingsConflictError } from '@hydra/harness-settings'

const { mockConnect, mockClose, mockListTools, MockClient } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockRequest = vi.fn(async (request: { method: string; params?: Record<string, unknown> }): Promise<unknown> => {
    if (request.method === 'tools/list') return await mockListTools(request.params)
    throw new Error(`unexpected MCP request: ${request.method}`)
  })
  class MockClient {
    connect = mockConnect
    close = mockClose
    listTools = mockListTools
    request = mockRequest
    setNotificationHandler = vi.fn()
  }
  return { mockConnect, mockClose, mockListTools, MockClient }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))

import McpServerRegistry, { MCP_SERVERS_SETTINGS_NAMESPACE } from '@hydra/harness-mcp-registry/src/index.ts'
import type { McpServerSnapshot } from '@hydra/harness-mcp-registry/src/types.ts'

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  mockConnect.mockReset()
  mockClose.mockReset()
  mockListTools.mockReset()
})

const STDIO = {
  mode: 'create' as const,
  name: 'notes',
  transport: 'stdio' as const,
  command: 'node',
  args: ['--version'],
  env: { NOTES_TOKEN: 'secret-value' },
}

async function mount(settingsPath: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
  await ctx.plugin(McpServerRegistry)
  return ctx
}

async function harness(): Promise<{ ctx: Context; registry: McpServerRegistry; settingsPath: string }> {
  primeSdk()
  const root = await mkdtemp(join(tmpdir(), 'hydra-mcp-registry-'))
  directories.push(root)
  const settingsPath = join(root, 'settings.yaml')
  const ctx = await mount(settingsPath)
  return { ctx, registry: ctx.get('mcpServers') as McpServerRegistry, settingsPath }
}

/**
 * A server that connects and lists one tool. `close` fires `onclose` because
 * the supervisor waits for the transport-owned close signal before it treats a
 * generation as gone.
 */
function primeSdk(): void {
  mockConnect.mockResolvedValue(undefined)
  mockClose.mockImplementation(function (this: { onclose?: () => void }) {
    this.onclose?.()
    return Promise.resolve()
  })
  mockListTools.mockResolvedValue({
    tools: [{ name: 'read', description: 'Read one note', inputSchema: { type: 'object' } }],
    nextCursor: undefined,
  })
}

/**
 * An external document write returns as soon as the section is committed; the
 * mounts it implies follow on the registry's own chain. `mcp-servers/reconciled`
 * is the settled edge, so a test that asserts mount state waits for it.
 */
function nextReconciliation(ctx: Context): Promise<McpServerSnapshot> {
  const settled: PromiseWithResolvers<McpServerSnapshot> = Promise.withResolvers()
  const off = ctx.on('mcp-servers/reconciled', (snapshot) => {
    off()
    settled.resolve(snapshot)
  })
  return settled.promise
}

describe('stored records', () => {
  it.each(['create', 'replace', 'setEnabled', 'remove'] as const)(
    'refuses a stale %s without restoring another deleted server, then accepts a refreshed retry', async (mode) => {
      const { registry, settingsPath } = await harness()
      await registry.define(STDIO)
      await registry.define({ ...STDIO, name: 'removed' })
      const peer = await mount(settingsPath)
      await registry.remove('removed')
      const before = await readFile(settingsPath, 'utf8')
      const write = () => mode === 'setEnabled'
        ? peer.mcpServers.setEnabled({ name: 'notes', enabled: false })
        : mode === 'remove' ? peer.mcpServers.remove('notes')
          : peer.mcpServers.define({ ...STDIO, mode, name: mode === 'create' ? 'added' : 'notes', command: 'updated' })

      await expect(write()).rejects.toBeInstanceOf(SettingsConflictError)
      expect(await readFile(settingsPath, 'utf8')).toBe(before)
      expect(peer.mcpServers.list().servers.map(server => server.name)).toEqual(['notes'])
      const accepted = await write()
      expect(accepted.servers.map(server => server.name)).toEqual(mode === 'remove' ? [] : mode === 'create' ? ['notes', 'added'] : ['notes'])
      if (mode === 'replace') expect(accepted.servers[0]?.command).toBe('updated')
      const restarted = await mount(settingsPath)
      expect(restarted.mcpServers.list()).toEqual(accepted)
    })

  it('keeps a server mounted after the API caller is disposed', async () => {
    const { ctx, registry } = await harness()
    const caller = await ctx.plugin({
      inject: ['mcpServers'],
      async apply(caller) { await caller.mcpServers.define({ ...STDIO, enabled: true }) },
    })
    await caller.dispose()
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['mcp__notes__read'])
    await registry.setEnabled({ name: 'notes', enabled: false })
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('rejects duplicate creates without changing or restarting the active server', async () => {
    const { registry, settingsPath } = await harness()
    await registry.define({ ...STDIO, enabled: true })
    const before = await readFile(settingsPath, 'utf8')
    await expect(registry.define({ ...STDIO, command: 'replacement' })).rejects.toThrow('already exists')
    expect(await readFile(settingsPath, 'utf8')).toBe(before)
    expect(registry.list().servers[0]).toMatchObject({ enabled: true, command: 'node', status: 'started' })
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('serializes competing creates and refuses replacing a removed record', async () => {
    const { registry } = await harness()
    const results = await Promise.allSettled([registry.define(STDIO), registry.define(STDIO)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    await registry.remove('notes')
    await expect(registry.define({ ...STDIO, mode: 'replace' })).rejects.toThrow('not configured')
    expect(registry.list().servers).toEqual([])
  })
  it('persists a defined record into the settings document', async () => {
    const { registry, settingsPath } = await harness()

    const snapshot = await registry.define(STDIO)

    expect(snapshot.servers).toEqual([{
      name: 'notes',
      transport: 'stdio',
      enabled: false,
      status: 'stopped',
      command: 'node',
      args: ['--version'],
      envNames: ['NOTES_TOKEN'],
      headerNames: [],
      toolCallTimeoutMs: 60_000,
      tools: [],
    }])
    const document = await readFile(settingsPath, 'utf8')
    expect(document).toContain('mcp-servers:')
    expect(document).toContain('name: notes')
    expect(document).toContain('command: node')
  })

  it('reads records the document already carries, so a hand edit needs no restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-mcp-registry-existing-'))
    directories.push(root)
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, [
      'mcp-servers:',
      '  servers:',
      '    - name: handwritten',
      '      transport: streamable-http',
      '      url: https://mcp.example.test/v1',
      '      enabled: false',
      '',
    ].join('\n'))

    const ctx = await mount(settingsPath)

    expect((ctx.get('mcpServers') as McpServerRegistry).list().servers).toEqual([{
      name: 'handwritten',
      transport: 'streamable-http',
      enabled: false,
      status: 'stopped',
      url: 'https://mcp.example.test/v1',
      envNames: [],
      headerNames: [],
      toolCallTimeoutMs: 60_000,
      tools: [],
    }])
  })

  it('replaces one record wholesale but keeps the credential-shaped maps it cannot restate', async () => {
    const { registry } = await harness()
    await registry.define(STDIO)

    const snapshot = await registry.define({ mode: 'replace',
      name: 'notes',
      transport: 'stdio',
      command: 'node',
      args: [],
      cwd: 'C:\\notes',
    })

    expect(snapshot.servers[0]).toMatchObject({
      args: [],
      cwd: 'C:\\notes',
      envNames: ['NOTES_TOKEN'],
    })
  })

  it('clears a stored env map only when the caller supplies one', async () => {
    const { registry } = await harness()
    await registry.define(STDIO)

    const snapshot = await registry.define({ ...STDIO, mode: 'replace', env: {} })

    expect(snapshot.servers[0]?.envNames).toEqual([])
  })

  it('drops one record and reports it is no longer configured', async () => {
    const { registry, settingsPath } = await harness()
    await registry.define(STDIO)

    await expect(registry.remove('notes')).resolves.toEqual({ servers: [] })
    expect(await readFile(settingsPath, 'utf8')).not.toContain('name: notes')
    await expect(registry.remove('notes')).rejects.toThrow('server notes is not configured')
  })

  it('refuses a definition it could not mount before anything persists', async () => {
    const { registry, settingsPath } = await harness()

    await expect(registry.define({ mode: 'create', name: 'no name', transport: 'stdio', command: 'node' }))
      .rejects.toThrow('server name must match')
    await expect(registry.define({ mode: 'create', name: 'blank', transport: 'stdio', command: '  ' }))
      .rejects.toThrow('requires a command')
    await expect(registry.define({ mode: 'create', name: 'remote', transport: 'streamable-http', url: 'ftp://mcp.example.test' }))
      .rejects.toThrow('must use HTTP or HTTPS')
    await expect(registry.define({ mode: 'create', name: 'remote', transport: 'streamable-http', url: 'not-a-url' }))
      .rejects.toThrow('url is not absolute')
    await expect(registry.define({ mode: 'create', name: 'remote', transport: 'streamable-http' }))
      .rejects.toThrow('requires a url')

    await expect(readFile(settingsPath, 'utf8')).rejects.toThrow()
    expect(registry.list().servers).toEqual([])
  })

  it('refuses a stored section that declares one name twice', async () => {
    const { ctx } = await harness()

    await expect(ctx.settings.replace(MCP_SERVERS_SETTINGS_NAMESPACE, {
      servers: [
        { name: 'notes', transport: 'stdio', command: 'node' },
        { name: 'notes', transport: 'stdio', command: 'python' },
      ],
    })).rejects.toThrow('is declared more than once')
  })
})

describe('mount reconciliation', () => {
  it('mounts an enabled record, registers its tools, and unmounts it again on disable', async () => {
    const { ctx, registry } = await harness()
    await registry.define(STDIO)

    const enabled = await registry.setEnabled({ name: 'notes', enabled: true })

    expect(enabled.servers[0]).toMatchObject({ enabled: true, status: 'started' })
    expect(enabled.servers[0]?.tools).toEqual(['mcp__notes__read'])
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('mcp__notes__read')

    const disabled = await registry.setEnabled({ name: 'notes', enabled: false })

    expect(disabled.servers[0]).toMatchObject({ enabled: false, status: 'stopped', tools: [] })
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('mcp__notes__read')
  })

  it('mounts every enabled record the document already carried at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hydra-mcp-registry-startup-'))
    directories.push(root)
    const settingsPath = join(root, 'settings.yaml')
    primeSdk()
    await writeFile(settingsPath, [
      'mcp-servers:',
      '  servers:',
      '    - name: notes',
      '      transport: stdio',
      '      command: node',
      '      enabled: true',
      '',
    ].join('\n'))

    const ctx = await mount(settingsPath)

    expect((ctx.get('mcpServers') as McpServerRegistry).list().servers[0])
      .toMatchObject({ enabled: true, status: 'started' })
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('mcp__notes__read')
  })

  it('remounts a live record when its definition changes', async () => {
    const { registry } = await harness()
    await registry.define({ ...STDIO, enabled: true })
    expect(mockConnect).toHaveBeenCalledTimes(1)

    await registry.define({ ...STDIO, mode: 'replace', command: 'python', enabled: true })

    expect(mockClose).toHaveBeenCalledTimes(1)
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(registry.list().servers[0]).toMatchObject({ command: 'python', status: 'started' })
  })

  it('leaves a live record alone when an unrelated record changes', async () => {
    const { registry } = await harness()
    await registry.define({ ...STDIO, enabled: true })
    expect(mockConnect).toHaveBeenCalledTimes(1)

    await registry.define({ mode: 'create', name: 'other', transport: 'stdio', command: 'node' })

    expect(mockClose).not.toHaveBeenCalled()
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('reports a stored record it refuses to mount instead of failing the process', async () => {
    const { ctx, registry } = await harness()

    const reconciled = nextReconciliation(ctx)
    await ctx.settings.replace(MCP_SERVERS_SETTINGS_NAMESPACE, {
      servers: [
        { name: 'broken', transport: 'stdio', command: '', enabled: true },
        { name: 'notes', transport: 'stdio', command: 'node', enabled: true },
      ],
    })
    await reconciled

    const [broken, notes] = registry.list().servers
    expect(broken).toMatchObject({ name: 'broken', enabled: true, status: 'invalid' })
    expect(broken?.detail).toContain('requires a command')
    // The refused record did not stop its sibling from mounting.
    expect(notes).toMatchObject({ name: 'notes', status: 'started' })
  })

  it('reports a record whose connection failed without unmounting the others', async () => {
    const { registry } = await harness()
    mockConnect.mockRejectedValue(new Error('connection refused'))

    await registry.define({ ...STDIO, enabled: true })

    expect(registry.list().servers[0]).toMatchObject({ enabled: true, status: 'failed' })
  })

  it('refuses to change a record that is not configured', async () => {
    const { registry } = await harness()

    await expect(registry.setEnabled({ name: 'absent', enabled: true }))
      .rejects.toThrow('server absent is not configured')
  })

  it('unmounts every live record when the fiber disposes', async () => {
    const { ctx, registry } = await harness()
    await registry.define({ ...STDIO, enabled: true })

    await ctx.fiber.dispose()

    expect(mockClose).toHaveBeenCalledTimes(1)
  })
})
