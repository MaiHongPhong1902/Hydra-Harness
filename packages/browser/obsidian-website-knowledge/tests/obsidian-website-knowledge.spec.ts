import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@bosch/cordis'
import { agentEvents, type Agent } from '@bosch/bh-agent'
import { CallId, createUserMessage } from '@bosch/bh-llm'
import SystemPrompt from '@bosch/bh-system-prompt'
import ApprovalService, { type ApprovalOutcome } from '@bosch/bh-user-approval'
import type { BrowserToolValue } from '@bosch/bh-tool-browser'
import ToolRuntime, { defineTool, type JsonValue, type ToolExecutionResult } from '@bosch/bh-tools'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import * as ObsidianWebsiteKnowledge from '../src/index.ts'
import {
  createLocalObsidianWebsiteGraph,
  matchesTargetDomain,
  normalizeTargetDomain,
  resolveSettings,
} from '../src/graph.ts'

const roots: string[] = []
const fixtureServers: FixtureMcp[] = []
const FIXTURE_MARKER_PATH = 'BH Website Knowledge/BH MCP Vault Identity.md'
const FIXTURE_MARKER_MARKDOWN = '# Fixture vault identity\n'

interface FixtureMcp {
  readonly url: string
  close(): Promise<void>
}

afterEach(async () => {
  await Promise.all(fixtureServers.splice(0).map(server => server.close()))
  await Promise.all(roots.splice(0).map(async root => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  })))
})

const initial: BrowserToolValue = {
  url: 'https://shop.test/orders',
  title: 'Orders',
  header: 'Current Page: [Orders](https://shop.test/orders)',
  content: '[1]<button id=new-order>New order</button>',
  footer: '[End of page]',
  tabs: [{ id: 1, url: 'https://shop.test/orders', title: 'Orders', status: 'complete', active: true }],
  tabId: 1,
  activeTabId: 1,
  settled: true,
  capturedAt: '2026-08-24T00:00:00.000Z',
  truncated: false,
}

function vaultFile(vaultPath: string, path: string): string {
  const root = resolve(vaultPath)
  const file = resolve(root, path)
  if (!file.startsWith(`${root}${sep}`)) throw new Error(`fixture MCP path is outside its vault: ${path}`)
  return file
}

async function markdownFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const children = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [path] : []
  }))
  return children.flat()
}

async function searchVault(vaultPath: string, query: string): Promise<unknown[]> {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean)
  const files = await markdownFiles(join(vaultPath, 'BH Website Knowledge'))
  const matches: unknown[] = []
  for (const file of files) {
    const markdown = await readFile(file, 'utf8')
    const filename = relative(vaultPath, file).replaceAll('\\', '/')
    if (terms.every(term => `${filename}\n${markdown}`.toLowerCase().includes(term))) {
      matches.push({ filename, score: 1, matches: [{ context: markdown.slice(0, 300) }] })
    }
  }
  return matches
}

async function startFixtureMcp(vaultPath: string): Promise<FixtureMcp> {
  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const server = new McpServer(
      { name: 'obsidian-vault-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.registerTool('search_simple', {
      inputSchema: { query: z.string(), contextLength: z.number().optional() },
    }, async ({ query }) => ({
      content: [{ type: 'text', text: JSON.stringify(await searchVault(vaultPath, query)) }],
    }))
    server.registerTool('vault_read', {
      inputSchema: { path: z.string() },
    }, async ({ path }) => {
      if (path === FIXTURE_MARKER_PATH) {
        return { content: [{ type: 'text', text: JSON.stringify({ path, content: FIXTURE_MARKER_MARKDOWN }) }] }
      }
      let content: string
      try {
        content = await readFile(vaultFile(vaultPath, path), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`File not found: ${path}`)
        throw error
      }
      return { content: [{ type: 'text', text: JSON.stringify({ path, content }) }] }
    })
    server.registerTool('vault_write', {
      inputSchema: { path: z.string(), content: z.string() },
    }, async ({ path, content }) => {
      const file = vaultFile(vaultPath, path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
      return { content: [{ type: 'text', text: JSON.stringify({ message: 'OK' }) }] }
    })
    const transport = new StreamableHTTPServerTransport({})
    res.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport as Transport)
    await transport.handleRequest(req, res)
  }

  const httpServer = createServer((req, res) => {
    handleMcpRequest(req, res).catch((error: unknown) => {
      res.writeHead(500).end(String(error))
    })
  })
  await new Promise<void>((resolveListening, rejectListening) => {
    httpServer.once('error', rejectListening)
    httpServer.listen(0, '127.0.0.1', resolveListening)
  })
  const address = httpServer.address()
  if (address === null || typeof address === 'string') throw new Error('expected fixture MCP TCP address')
  let closePromise: Promise<void> | undefined
  const fixture = {
    url: `http://127.0.0.1:${address.port}/mcp/`,
    close: () => closePromise ??= new Promise<void>((resolveClose, rejectClose) => {
      httpServer.close(error => error === undefined ? resolveClose() : rejectClose(error))
    }),
  }
  fixtureServers.push(fixture)
  return fixture
}

async function pluginHarness(vaultPath: string, value: BrowserToolValue, approval?: ApprovalOutcome) {
  const mcp = await startFixtureMcp(vaultPath)
  const ctx = new Context()
  ctx.provide('credentials', {
    resolve: async () => ({ value: 'fixture-token', source: 'fixture' }),
  } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService)
  const approvalState: { value?: ApprovalOutcome } = {}
  if (approval !== undefined) {
    approvalState.value = approval
    ctx.on('approval/request', () => Promise.resolve(approvalState.value ?? 'cancelled'))
  }
  await ctx.plugin(ObsidianWebsiteKnowledge, { targetDomain: 'shop.test', mcpUrl: mcp.url })
  ctx.tools.register(defineTool({
    name: 'browser_state',
    description: 'fixture browser state',
    parameters: { tab_id: { type: 'integer' } },
    output: { schema: { type: 'json' }, render: () => [] },
    execute: async args => ({
      ...value,
      tabId: args.tab_id ?? value.tabId,
    }),
  }))
  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'fixture browser navigation',
    parameters: {
      url: { type: 'string', required: true },
      tab_id: { type: 'integer' },
    },
    output: { schema: { type: 'json' }, render: () => [] },
    execute: async args => ({
      ...value,
      action: { success: true, message: 'navigate succeeded' },
      url: args.url,
      tabId: args.tab_id ?? value.tabId,
    }),
  }))
  ctx.tools.register(defineTool({
    name: 'browser_open_tab',
    description: 'fixture browser tab navigation',
    parameters: { url: { type: 'string' } },
    output: { schema: { type: 'json' }, render: () => [] },
    execute: async args => ({
      ...value,
      action: { success: true, message: 'open tab succeeded' },
      url: args.url ?? 'about:blank',
    }),
  }))
  const steered: string[] = []
  const agent = {
    session: { events: [{ type: 'turn/start' }], append: () => ({}) },
    steer: (message: ReturnType<typeof createUserMessage>) => {
      steered.push(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    },
  } as unknown as Agent
  const call = (name: string, arguments_: Record<string, JsonValue> = {}) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(name),
    name,
    arguments: arguments_,
    agent,
  })
  const beginTurn = (turn: number, text?: string) => agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    {
      messages: text === undefined ? [] : [createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })],
      turn,
      step: 1,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  const stopTurn = (turn: number) => agentEvents(ctx, agent).serial(
    'agent/turn-stopping',
    { turn, signal: new AbortController().signal },
  )
  return {
    ctx,
    call,
    beginTurn,
    stopTurn,
    steered,
    setApproval: (outcome: ApprovalOutcome) => { approvalState.value = outcome },
    dispose: async () => {
      try {
        await ctx.fiber.dispose()
      } finally {
        await mcp.close()
      }
    },
  }
}

function firstText(result: ToolExecutionResult): string {
  const content = result.content[0]
  return content?.type === 'text' ? content.text : ''
}

describe('Obsidian website knowledge graph', () => {
  it('uses an exact hostname gate', () => {
    expect(normalizeTargetDomain('SHOP.test')).toBe('shop.test')
    expect(matchesTargetDomain('https://shop.test/orders', 'shop.test')).toBe(true)
    expect(matchesTargetDomain('https://admin.shop.test/orders', 'shop.test')).toBe(false)
    expect(matchesTargetDomain('https://shop.test.evil.example/orders', 'shop.test')).toBe(false)
    expect(() => normalizeTargetDomain('https://shop.test')).toThrow(/hostname/)
    expect(resolveSettings({ targetDomain: 'shop.test' })).toEqual({ targetDomain: 'shop.test' })
  })

  it('writes page, control, and observed browser transition notes without storing typed values', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'bh-obsidian-knowledge-'))
    roots.push(vaultPath)
    const graph = createLocalObsidianWebsiteGraph({ targetDomain: 'shop.test', vaultPath })
    const before = graph.page(initial)
    await graph.record(undefined, 'browser_state', {}, before)
    const after = graph.page({
      ...initial,
      url: 'https://shop.test/orders/new',
      title: 'New order',
      content: '[4]<input id=name/>',
    })
    await graph.record(before, 'browser_click', { index: 1 }, after)

    const page = await graph.read(before)
    expect(page).toContain('New order')
    expect(page).toContain('Observed actions')
    expect(page).toContain('[[BH Website Knowledge/shop.test/actions/')
    const actionDirectory = join(vaultPath, 'BH Website Knowledge', 'shop.test', 'actions')
    const actionName = (await (await import('node:fs/promises')).readdir(actionDirectory))[0]
    const action = await readFile(join(actionDirectory, actionName!), 'utf8')
    expect(action).toContain('From [[BH Website Knowledge/shop.test/pages/')
    expect(action).toContain('Control: [[BH Website Knowledge/shop.test/controls/')
    expect(action).not.toContain('New order</button>')
  })

  it('searches and exactly reads imported test knowledge while containing note paths', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'bh-obsidian-knowledge-search-'))
    roots.push(vaultPath)
    const root = join(vaultPath, 'BH Website Knowledge', 'WorkON UAT June 2026')
    const imported = join(root, 'Test Cases')
    await mkdir(imported, { recursive: true })
    await writeFile(join(vaultPath, 'BH Website Knowledge', 'BH MCP Vault Identity.md'), '# Fixture identity marker\n')
    await writeFile(join(root, '00 Index.md'), '# UAT index\n\nApplication search coverage.\n')
    await mkdir(join(root, 'Features'), { recursive: true })
    await writeFile(join(root, 'Features', 'application-search.md'), '---\ntype: uat-feature\n---\n\n# Application search\n\nFeature candidate.\n')
    await writeFile(join(imported, 'TC-0001.md'), '---\ntype: uat-test-case\n---\n\n# TC_001 — Verify application search\n\n## Source columns\n\n- Preconditions: User is signed in\n- Steps: Search for Payroll\n- Expected result: Payroll is listed\n- Test data: Payroll\n')
    const approved = join(root, 'Approved Knowledge')
    await mkdir(approved, { recursive: true })
    await writeFile(join(approved, 'workon-backoffice-entrypoint.md'), '# WorkOnBackoffice browser entrypoint\n\n- URL: https://shop.test/workon\n- Provenance: user-approved\n')
    const graph = createLocalObsidianWebsiteGraph({ targetDomain: 'shop.test', vaultPath })

    await expect(graph.search('application search')).resolves.toMatchObject([
      { path: 'BH Website Knowledge/WorkON UAT June 2026/Test Cases/TC-0001', title: 'TC_001 — Verify application search' },
      { path: 'BH Website Knowledge/WorkON UAT June 2026/Features/application-search', title: 'Application search' },
      { path: 'BH Website Knowledge/WorkON UAT June 2026/00 Index', title: 'UAT index' },
    ])
    await expect(graph.search('WorkOnBackoffice browser entrypoint')).resolves.toMatchObject([
      { path: 'BH Website Knowledge/WorkON UAT June 2026/Approved Knowledge/workon-backoffice-entrypoint', title: 'WorkOnBackoffice browser entrypoint' },
    ])
    await expect(graph.search('fixture identity marker')).resolves.toEqual([])
    const notes = await graph.readNotes([
      'BH Website Knowledge/WorkON UAT June 2026/Features/application-search',
      'BH Website Knowledge/WorkON UAT June 2026/Test Cases/TC-0001',
      'BH Website Knowledge/WorkON UAT June 2026/Test Cases/TC-0001',
    ])
    expect(notes.map(note => note.path)).toEqual([
      'BH Website Knowledge/WorkON UAT June 2026/Features/application-search',
      'BH Website Knowledge/WorkON UAT June 2026/Test Cases/TC-0001',
    ])
    expect(notes[0]?.markdown).toContain('Feature candidate.')
    expect(notes[1]?.markdown).toContain('- Preconditions: User is signed in')
    await expect(graph.readNotes(['BH Website Knowledge/../secret'])).rejects.toThrow(/invalid website knowledge note path/)
    await expect(graph.readNotes(['BH Website Knowledge/WorkON UAT June 2026/Test Cases/missing'])).rejects.toThrow(/note not found/)

    const outside = join(vaultPath, 'Outside Knowledge')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.md'), 'outside')
    await symlink(outside, join(vaultPath, 'BH Website Knowledge', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(graph.readNotes(['BH Website Knowledge/escape/secret'])).rejects.toThrow(/outside BH Website Knowledge/)

    const path = await graph.saveApproved('New search coverage', 'Add a regression case for the new filter.', 'User request; Browser: https://shop.test/apps')
    expect(await readFile(join(vaultPath, `${path}.md`), 'utf8')).toContain('provenance: user-approved-agent-proposal')
  })

  it('reads persisted notes without Browser but gates current-page evidence by domain', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'bh-obsidian-knowledge-plugin-'))
    roots.push(vaultPath)
    const persistedPath = 'BH Website Knowledge/Imported/Test Cases/TC-0001'
    await mkdir(join(vaultPath, 'BH Website Knowledge', 'Imported', 'Test Cases'), { recursive: true })
    await writeFile(join(vaultPath, `${persistedPath}.md`), '# Complete persisted case\n\nApplication label: WorkOn Next Gen Portal\n\nPortal identity: WorkOnPortal\n\nPreconditions: User is logged into WorkOnBackoffice\n\nExpected result: visible\n')
    const target = await pluginHarness(vaultPath, initial, 'allowed-once')
    const blockedRootBeforeKnowledge = await target.call('browser_navigate', { url: 'https://shop.test/' })
    expect(blockedRootBeforeKnowledge.isError).toBe(true)
    expect(firstText(blockedRootBeforeKnowledge)).toContain('Read the complete testcase knowledge note')
    expect((await target.call('browser_open_tab', { url: 'https://shop.test/' })).isError).toBe(true)
    const persisted = await target.call('website_knowledge_read_notes', { paths: [persistedPath] })
    expect(persisted.isError).toBe(false)
    expect(firstText(persisted)).toContain('Expected result: visible')
    expect(firstText(persisted)).toContain('WorkOnPortal: https://shop.test/WorkOnPortal/')
    expect(firstText(persisted)).toContain('WorkOnBackoffice: https://shop.test/WorkOnBackoffice/')
    expect(firstText(persisted)).not.toContain('https://shop.test/WorkOnNext/')
    expect((await target.call('website_knowledge_read')).isError).toBe(true)
    const blockedRoot = await target.call('browser_navigate', { url: 'https://shop.test/' })
    expect(blockedRoot.isError).toBe(true)
    expect(firstText(blockedRoot)).toContain('WorkOnPortal -> https://shop.test/WorkOnPortal/')
    expect((await target.call('browser_navigate', { url: 'https://shop.test/WorkOnPortal/' })).isError).toBe(false)
    expect((await target.call('browser_open_tab', { url: 'https://shop.test/WorkOnPortal/' })).isError).toBe(false)
    expect((await target.call('browser_navigate', { url: 'https://shop.test/orders' })).isError).toBe(false)
    expect((await target.call('browser_state')).isError).toBe(false)
    const read = await target.call('website_knowledge_read')
    expect(read.isError).toBe(false)
    expect(firstText(read)).toContain('Knowledge graph for https://shop.test/orders')
    const saved = await target.call('website_knowledge_save_approved', {
      approval: 'approved-by-user',
      title: 'Orders coverage',
      content: 'User-approved regression coverage.',
      evidence: 'User request; Browser: https://shop.test/orders',
    })
    expect(saved.isError).toBe(false)
    const actionDirectory = join(vaultPath, 'BH Website Knowledge', 'shop.test', 'actions')
    const actionName = (await (await import('node:fs/promises')).readdir(actionDirectory))[0]
    const action = await readFile(join(actionDirectory, actionName!), 'utf8')
    expect(action).toContain('success: true')
    expect(action).toContain('message: "navigate succeeded"')
    const search = await target.call('website_knowledge_search', { query: 'orders' })
    expect(search.isError).toBe(false)
    expect(firstText(search)).toContain('via obsidian-mcp')
    await target.dispose()

    const offDomain = await pluginHarness(vaultPath, { ...initial, url: 'https://other.test/orders' })
    expect((await offDomain.call('browser_state')).isError).toBe(false)
    const rejected = await offDomain.call('website_knowledge_read')
    expect(rejected.isError).toBe(true)
    expect(firstText(rejected)).toContain('browse the configured website')
    await offDomain.dispose()
  })

  it('links observed browser transitions within each tab', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'bh-obsidian-knowledge-tabs-'))
    roots.push(vaultPath)
    const target = await pluginHarness(vaultPath, initial, 'allowed-once')
    const first = 'https://shop.test/tab-one/start'
    const second = 'https://shop.test/tab-two/start'
    const last = 'https://shop.test/tab-one/end'
    const graph = createLocalObsidianWebsiteGraph({ targetDomain: 'shop.test', vaultPath })
    const firstPage = graph.page({ ...initial, url: first })
    const secondPage = graph.page({ ...initial, url: second })
    const lastPage = graph.page({ ...initial, url: last })

    expect((await target.call('browser_navigate', { url: first, tab_id: 1 })).isError).toBe(false)
    expect((await target.call('browser_navigate', { url: second, tab_id: 2 })).isError).toBe(false)
    expect((await target.call('browser_navigate', { url: last, tab_id: 1 })).isError).toBe(false)
    expect((await target.call('website_knowledge_save_approved', {
      approval: 'approved-by-user',
      title: 'Per-tab browser evidence',
      content: 'Keep browser transitions attached to their source tab.',
      evidence: `Live Browser: ${first} ${second} ${last}`,
    })).isError).toBe(false)

    const actionDirectory = join(vaultPath, 'BH Website Knowledge', 'shop.test', 'actions')
    const actions = await Promise.all((await readdir(actionDirectory))
      .map(name => readFile(join(actionDirectory, name), 'utf8')))
    expect(actions.join('\n')).toContain(`/pages/${firstPage.id}`)
    expect(actions.join('\n')).toContain(`/pages/${lastPage.id}`)
    expect(actions.join('\n')).not.toContain(`/pages/${secondPage.id}`)
    await target.dispose()
  })

  it('forces one Browser step for an explicit live verification with an application candidate', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'bh-obsidian-knowledge-browser-required-'))
    roots.push(vaultPath)
    const persistedPath = 'BH Website Knowledge/Imported/Test Cases/TC-0001'
    await mkdir(join(vaultPath, 'BH Website Knowledge', 'Imported', 'Test Cases'), { recursive: true })
    await writeFile(join(vaultPath, `${persistedPath}.md`), '# TC-0001\n\nApplication: WorkOnPortal\n')
    const target = await pluginHarness(vaultPath, initial)

    await target.beginTurn(1, 'verify TC-0001 on the live UI')
    expect((await target.call('website_knowledge_read_notes', { paths: [persistedPath] })).isError).toBe(false)
    await target.stopTurn(1)
    expect(target.steered).toHaveLength(1)
    expect(target.steered[0]).toContain('call browser_navigate')
    await target.stopTurn(1)
    expect(target.steered).toHaveLength(1)

    await target.beginTurn(2, 'show TC-0001 source fields')
    expect((await target.call('website_knowledge_read_notes', { paths: [persistedPath] })).isError).toBe(false)
    expect((await target.call('browser_navigate', { url: 'https://other.test/' })).isError).toBe(false)
    await target.stopTurn(2)
    expect(target.steered).toHaveLength(1)

    await target.beginTurn(3, 'kiểm chứng TC-0001')
    expect((await target.call('website_knowledge_read_notes', { paths: [persistedPath] })).isError).toBe(false)
    const wrongDomain = await target.call('browser_navigate', { url: 'http://127.0.0.1:3080/' })
    expect(wrongDomain.isError).toBe(true)
    expect(firstText(wrongDomain)).toContain('cannot navigate outside the configured target domain shop.test')
    expect((await target.call('browser_open_tab', { url: 'https://other.test/' })).isError).toBe(true)
    expect((await target.call('browser_navigate', { url: 'https://shop.test/WorkOnPortal/' })).isError).toBe(false)
    await target.stopTurn(3)
    expect(target.steered).toHaveLength(1)
    await target.dispose()
  })

  it('requires host approval before committing staged or approved knowledge', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'bh-obsidian-knowledge-approval-'))
    roots.push(vaultPath)
    const target = await pluginHarness(vaultPath, initial, 'rejected')
    expect((await target.call('browser_state')).isError).toBe(false)
    const saved = await target.call('website_knowledge_save_approved', {
      approval: 'approved-by-user',
      title: 'Rejected proposal',
      content: 'Must not be written.',
      evidence: 'User did not approve this proposal.',
    })
    expect(saved.isError).toBe(true)
    await expect(access(join(vaultPath, 'BH Website Knowledge'))).rejects.toThrow()
    await target.dispose()
  })

  it('commits only current proposal Browser evidence across the approval turn boundary', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'bh-obsidian-knowledge-proposal-'))
    roots.push(vaultPath)
    const target = await pluginHarness(vaultPath, initial, 'allowed-once')
    await target.beginTurn(1)
    expect((await target.call('browser_navigate', { url: 'https://shop.test/unrelated' })).isError).toBe(false)
    expect((await target.call('browser_navigate', { url: 'https://shop.test/approved' })).isError).toBe(false)
    expect((await target.call('browser_navigate', { url: 'https://other.test/reset' })).isError).toBe(false)
    await target.beginTurn(2)
    expect((await target.call('browser_navigate', { url: 'https://shop.test/approved' })).isError).toBe(false)

    const saved = await target.call('website_knowledge_save_approved', {
      approval: 'approved-by-user',
      title: 'Approved Browser evidence',
      content: 'Persist only the evidence cited by this proposal.',
      evidence: 'Live Browser: https://shop.test/approved',
    })
    expect(saved.isError).toBe(false)
    const pageDirectory = join(vaultPath, 'BH Website Knowledge', 'shop.test', 'pages')
    const pages = await Promise.all((await (await import('node:fs/promises')).readdir(pageDirectory))
      .map(name => readFile(join(pageDirectory, name), 'utf8')))
    expect(pages.join('\n')).toContain('https://shop.test/approved')
    expect(pages.join('\n')).not.toContain('https://shop.test/unrelated')
    await expect(access(join(vaultPath, 'BH Website Knowledge', 'shop.test', 'actions'))).rejects.toThrow()
    await target.dispose()
  })

  it('does not attach stale Browser evidence but keeps cancelled evidence available for a retry', async () => {
    const staleVaultPath = await mkdtemp(join(tmpdir(), 'bh-obsidian-knowledge-stale-'))
    roots.push(staleVaultPath)
    const stale = await pluginHarness(staleVaultPath, initial, 'allowed-once')
    await stale.beginTurn(1)
    expect((await stale.call('browser_navigate', { url: 'https://shop.test/stale' })).isError).toBe(false)
    await stale.beginTurn(3)
    expect((await stale.call('website_knowledge_save_approved', {
      approval: 'approved-by-user',
      title: 'Proposal without current Browser evidence',
      content: 'Save the approved proposal only.',
      evidence: 'Historical Browser URL: https://shop.test/stale',
    })).isError).toBe(false)
    await expect(access(join(staleVaultPath, 'BH Website Knowledge', 'shop.test', 'pages'))).rejects.toThrow()
    await stale.dispose()

    const retryVaultPath = await mkdtemp(join(tmpdir(), 'bh-obsidian-knowledge-cancelled-'))
    roots.push(retryVaultPath)
    const retry = await pluginHarness(retryVaultPath, initial, 'cancelled')
    await retry.beginTurn(1)
    expect((await retry.call('browser_navigate', { url: 'https://shop.test/retry' })).isError).toBe(false)
    await retry.beginTurn(2)
    const proposal = {
      approval: 'approved-by-user',
      title: 'Retried proposal',
      content: 'Persist after explicit approval.',
      evidence: 'Live Browser: https://shop.test/retry',
    } as const
    expect((await retry.call('website_knowledge_save_approved', proposal)).isError).toBe(true)
    retry.setApproval('allowed-once')
    expect((await retry.call('website_knowledge_save_approved', proposal)).isError).toBe(false)
    await expect(access(join(retryVaultPath, 'BH Website Knowledge', 'shop.test', 'pages'))).resolves.toBeUndefined()
    await retry.dispose()
  })

  it('tells the model to search precisely and require test-case evidence for coverage', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'bh-obsidian-knowledge-prompt-'))
    roots.push(vaultPath)
    const target = await pluginHarness(vaultPath, initial)
    const section = (await target.ctx.systemPrompt.assemble()).sections
      .find(item => item.name === 'browser:obsidian-website-knowledge')
    expect(section?.text).toContain('once per distinct term with exactly {"query":"term"}')
    expect(section?.text).toContain('call website_knowledge_read_notes with the exact candidate paths')
    expect(section?.text).toContain('Search excerpts locate notes only')
    expect(section?.text).toContain('do not repeat paraphrased searches or use glob, grep')
    expect(section?.text).toContain('A coverage decision requires a matching complete individual UAT test-case note')
    expect(section?.text).toContain('A direct browser-operation request (open, sign in, navigate, click, search, or create) is not a coverage lookup')
    expect(section?.text).toContain('call browser_* before reporting a live result')
    expect(section?.text).toContain('report Blocked rather than invent or alter it')
    expect(section?.text).toContain('The configured targetDomain is shop.test')
    expect(section?.text).toContain('search website knowledge for the required role plus "browser entrypoint"')
    expect(section?.text).toContain('website_knowledge_read_notes emits same-domain application-root navigation candidates')
    expect(section?.text).toContain('select the emitted navigation candidate whose application matches')
    expect(section?.text).toContain('Never navigate to the bare configured domain https://shop.test/')
    expect(section?.text).toContain('ask the user for an entrypoint URL')
    expect(section?.text).toContain('Navigation URLs remain ephemeral')
    expect(section?.text).toContain('list every live Browser result URL that belongs to that proposal')
    expect(section?.text).toContain('report Blocked and name the missing or conflicting application identity')
    expect(section?.text).toContain('report Unresolved instead of inferring, inventing, or falling back to filesystem discovery')
    await target.dispose()
  })
})
