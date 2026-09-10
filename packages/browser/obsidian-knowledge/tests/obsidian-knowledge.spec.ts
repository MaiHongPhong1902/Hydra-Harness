import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@hydra/cordis'
import type { Agent } from '@hydra/harness-agent'
import { CallId } from '@hydra/harness-llm'
import SystemPrompt from '@hydra/harness-system-prompt'
import ApprovalService, { type ApprovalOutcome } from '@hydra/harness-user-approval'
import ToolRuntime, { defineTool, type JsonValue, type ToolExecutionResult } from '@hydra/harness-tools'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod'
import * as ObsidianKnowledge from '../src/index.ts'
import { createLocalObsidianKnowledgeGraph, ObsidianKnowledgeGraph } from '../src/graph.ts'
import type { ObsidianKnowledgeStorage } from '../src/graph.ts'

const roots: string[] = []
const fixtureServers: FixtureMcp[] = []
const FIXTURE_MARKER_PATH = 'Hydra Website Knowledge/Hydra MCP Vault Identity.md'
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
  const files = await markdownFiles(join(vaultPath, 'Hydra Website Knowledge'))
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
      httpServer.close((error) => {
        if (error === undefined) resolveClose()
        else rejectClose(error)
      })
    }),
  }
  fixtureServers.push(fixture)
  return fixture
}

async function pluginHarness(
  vaultPath: string,
  approval?: ApprovalOutcome,
  registerBrowserTools = false,
) {
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
  await ctx.plugin(ObsidianKnowledge, { mcpUrl: mcp.url })
  if (registerBrowserTools) {
    ctx.tools.register(defineTool({
      name: 'browser_state',
      description: 'fixture browser state',
      parameters: { tab_id: { type: 'integer' } },
      output: { schema: { type: 'json' }, render: () => [] },
      execute: async () => ({ url: 'https://shop.test/orders' }),
    }))
    ctx.tools.register(defineTool({
      name: 'browser_navigate',
      description: 'fixture browser navigation',
      parameters: { url: { type: 'string', required: true }, tab_id: { type: 'integer' } },
      output: { schema: { type: 'json' }, render: () => [] },
      execute: async args => ({ url: args.url, action: { success: true, message: 'navigate succeeded' } }),
    }))
  }
  const agent = {
    session: { events: [{ type: 'turn/start' }], append: () => ({}) },
    steer: () => {},
  } as unknown as Agent
  const call = (name: string, arguments_: Record<string, JsonValue> = {}) => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(name),
    name,
    arguments: arguments_,
    agent,
  })
  return {
    ctx,
    call,
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

describe('Obsidian knowledge graph', () => {
  it('recalls and reads graph memory without any Browser tool registered', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'hydra-obsidian-knowledge-generic-'))
    roots.push(vaultPath)
    const notePath = 'Hydra Website Knowledge/Team Decisions/release-policy'
    await mkdir(join(vaultPath, 'Hydra Website Knowledge', 'Team Decisions'), { recursive: true })
    await writeFile(join(vaultPath, 'Hydra Website Knowledge', 'Hydra MCP Vault Identity.md'), FIXTURE_MARKER_MARKDOWN)
    await writeFile(join(vaultPath, `${notePath}.md`), '# Release policy\n\nDeploy only after smoke tests pass.\n')
    const target = await pluginHarness(vaultPath)

    const recall = await target.call('obsidian_knowledge_recall', { query: 'release policy' })
    expect(recall.isError).toBe(false)
    expect(firstText(recall)).toContain(notePath)
    const read = await target.call('obsidian_knowledge_read', { paths: [notePath] })
    expect(read.isError).toBe(false)
    expect(firstText(read)).toContain('Deploy only after smoke tests pass.')
    const prompt = (await target.ctx.systemPrompt.assemble()).sections
      .find(section => section.name === 'memory:obsidian-knowledge')?.text
    expect(prompt).toContain('Use obsidian_knowledge_recall once per distinct intent')
    await target.dispose()
  })

  it('runs Browser tools unmodified when Obsidian is mounted alongside them', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'hydra-obsidian-knowledge-browser-independent-'))
    roots.push(vaultPath)
    await mkdir(join(vaultPath, 'Hydra Website Knowledge'), { recursive: true })
    await writeFile(join(vaultPath, 'Hydra Website Knowledge', 'Hydra MCP Vault Identity.md'), FIXTURE_MARKER_MARKDOWN)
    const target = await pluginHarness(vaultPath, undefined, true)

    // No URL is blocked, no extra turn is forced, and no vault write happens as a side effect.
    const state = await target.call('browser_state')
    expect(state.isError).toBe(false)
    const navigate = await target.call('browser_navigate', { url: 'https://shop.test/' })
    expect(navigate.isError).toBe(false)
    const navigateElsewhere = await target.call('browser_navigate', { url: 'https://other.test/anything' })
    expect(navigateElsewhere.isError).toBe(false)
    await expect(access(join(vaultPath, 'Hydra Website Knowledge', 'shop.test'))).rejects.toThrow()
    await expect(access(join(vaultPath, 'Hydra Website Knowledge', 'other.test'))).rejects.toThrow()
    await target.dispose()
  })

  it('recalls every testcase linked by one feature without returning their bodies', async () => {
    const featurePath = 'Hydra Website Knowledge/UAT June 2026/Features/clear-filters'
    const relatedPaths = Array.from(
      { length: 15 },
      (_, index) => `Hydra Website Knowledge/UAT June 2026/Test Cases/TC-${String(index + 1).padStart(4, '0')}`,
    )
    const feature = {
      path: featurePath,
      markdown: `---\ntype: uat-feature\n---\n\n# Clear filters\n\n${relatedPaths.map((path, index) => `- [[Test Cases/${path.split('/').at(-1)}|Case ${index + 1}]]`).join('\n')}`,
    }
    const storage: ObsidianKnowledgeStorage = {
      write: async () => {},
      search: async () => [{ path: featurePath, title: 'Clear filters', excerpt: 'raw MCP excerpt' }],
      readNotes: async () => [feature],
    }
    const recall = await new ObsidianKnowledgeGraph(storage).recall('clear filters')

    expect(recall.matches[0]?.excerpt).toContain('# Clear filters')
    expect(recall.matches[0]?.excerpt.length).toBeLessThanOrEqual(322)
    expect(recall.related.map(relation => relation.path)).toEqual(relatedPaths)
    expect(recall.related.every(relation => relation.sourcePath === featurePath)).toBe(true)
    const fallbackRecall = await new ObsidianKnowledgeGraph(storage).recall('semantic alias')
    expect(fallbackRecall.matches[0]?.excerpt).toContain('# Clear filters')
  })

  it('searches and exactly reads imported test knowledge while containing note paths', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'hydra-obsidian-knowledge-search-'))
    roots.push(vaultPath)
    const root = join(vaultPath, 'Hydra Website Knowledge', 'UAT June 2026')
    const imported = join(root, 'Test Cases')
    await mkdir(imported, { recursive: true })
    await writeFile(join(vaultPath, 'Hydra Website Knowledge', 'Hydra MCP Vault Identity.md'), '# Fixture identity marker\n')
    await writeFile(join(root, '00 Index.md'), '# UAT index\n\nApplication search coverage.\n')
    await mkdir(join(root, 'Features'), { recursive: true })
    await writeFile(join(root, 'Features', 'application-search.md'), '---\ntype: uat-feature\n---\n\n# Application search\n\nFeature candidate.\n')
    await writeFile(join(imported, 'TC-0001.md'), '---\ntype: uat-test-case\n---\n\n# TC_001 — Verify application search\n\n## Source columns\n\n- Preconditions: User is signed in\n- Steps: Search for Payroll\n- Expected result: Payroll is listed\n- Test data: Payroll\n')
    const approved = join(root, 'Approved Knowledge')
    await mkdir(approved, { recursive: true })
    await writeFile(join(approved, 'shop-backoffice-entrypoint.md'), '# ShopBackoffice browser entrypoint\n\n- Provenance: user-approved\n')
    const graph = createLocalObsidianKnowledgeGraph({ vaultPath })

    await expect(graph.recall('application search')).resolves.toMatchObject({ matches: [
      { path: 'Hydra Website Knowledge/UAT June 2026/Test Cases/TC-0001', title: 'TC_001 — Verify application search' },
      { path: 'Hydra Website Knowledge/UAT June 2026/Features/application-search', title: 'Application search' },
      { path: 'Hydra Website Knowledge/UAT June 2026/00 Index', title: 'UAT index' },
    ] })
    await expect(graph.recall('ShopBackoffice browser entrypoint')).resolves.toMatchObject({ matches: [
      { path: 'Hydra Website Knowledge/UAT June 2026/Approved Knowledge/shop-backoffice-entrypoint', title: 'ShopBackoffice browser entrypoint' },
    ] })
    await expect(graph.recall('fixture identity marker')).resolves.toEqual({ matches: [], related: [] })
    const notes = await graph.readNotes([
      'Hydra Website Knowledge/UAT June 2026/Features/application-search',
      'Hydra Website Knowledge/UAT June 2026/Test Cases/TC-0001',
      'Hydra Website Knowledge/UAT June 2026/Test Cases/TC-0001',
    ])
    expect(notes.map(note => note.path)).toEqual([
      'Hydra Website Knowledge/UAT June 2026/Features/application-search',
      'Hydra Website Knowledge/UAT June 2026/Test Cases/TC-0001',
    ])
    expect(notes[0]?.markdown).toContain('Feature candidate.')
    expect(notes[1]?.markdown).toContain('- Preconditions: User is signed in')
    await expect(graph.readNotes(['Hydra Website Knowledge/../secret'])).rejects.toThrow(/invalid Obsidian knowledge note path/)
    await expect(graph.readNotes(['Hydra Website Knowledge/UAT June 2026/Test Cases/missing'])).rejects.toThrow(/note not found/)

    const outside = join(vaultPath, 'Outside Knowledge')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.md'), 'outside')
    await symlink(outside, join(vaultPath, 'Hydra Website Knowledge', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(graph.readNotes(['Hydra Website Knowledge/escape/secret'])).rejects.toThrow(/outside Hydra Website Knowledge/)

    const path = await graph.saveApproved('New search coverage', 'Add a regression case for the new filter.', 'User request; see linked feature note.')
    expect(await readFile(join(vaultPath, `${path}.md`), 'utf8')).toContain('provenance: user-approved-agent-proposal')
  })

  it('recalls and reads through the mounted plugin regardless of approval outcome', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'hydra-obsidian-knowledge-plugin-'))
    roots.push(vaultPath)
    const persistedPath = 'Hydra Website Knowledge/Imported/Test Cases/TC-0001'
    await mkdir(join(vaultPath, 'Hydra Website Knowledge', 'Imported', 'Test Cases'), { recursive: true })
    await writeFile(join(vaultPath, `${persistedPath}.md`), '# Complete persisted case\n\nExpected result: visible\n')
    const target = await pluginHarness(vaultPath, 'allowed-once')

    const persisted = await target.call('obsidian_knowledge_read', { paths: [persistedPath] })
    expect(persisted.isError).toBe(false)
    expect(firstText(persisted)).toContain('Expected result: visible')

    const saved = await target.call('obsidian_knowledge_save_approved', {
      approval: 'approved-by-user',
      title: 'Coverage note',
      content: 'User-approved regression coverage.',
      evidence: `User request; source-note: ${persistedPath}`,
    })
    expect(saved.isError).toBe(false)
    const search = await target.call('obsidian_knowledge_recall', { query: 'coverage note' })
    expect(search.isError).toBe(false)
    expect(firstText(search)).toContain('via obsidian-mcp')
    await target.dispose()
  })

  it('requires host approval before committing approved knowledge', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'hydra-obsidian-knowledge-approval-'))
    roots.push(vaultPath)
    const target = await pluginHarness(vaultPath, 'rejected')
    const saved = await target.call('obsidian_knowledge_save_approved', {
      approval: 'approved-by-user',
      title: 'Rejected proposal',
      content: 'Must not be written.',
      evidence: 'User did not approve this proposal.',
    })
    expect(saved.isError).toBe(true)
    await expect(access(join(vaultPath, 'Hydra Website Knowledge'))).rejects.toThrow()
    await target.dispose()
  })

  it('tells the model to recall precisely and require test-case evidence for coverage, without any Browser rule', async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), 'hydra-obsidian-knowledge-prompt-'))
    roots.push(vaultPath)
    const target = await pluginHarness(vaultPath)
    const section = (await target.ctx.systemPrompt.assemble()).sections
      .find(item => item.name === 'memory:obsidian-knowledge')
    expect(section?.text).toContain('Use obsidian_knowledge_recall once per distinct intent')
    expect(section?.text).toContain('call obsidian_knowledge_read once with up to 32 paths')
    expect(section?.text).toContain('excerpt or graph edge locates evidence')
    expect(section?.text).toContain('glob, grep, or filesystem tools')
    expect(section?.text).toContain('Coverage requires a complete individual UAT case')
    expect(section?.text).not.toContain('browser_')
    expect(section?.text).not.toContain('Browser')
    await target.dispose()
  })
})
