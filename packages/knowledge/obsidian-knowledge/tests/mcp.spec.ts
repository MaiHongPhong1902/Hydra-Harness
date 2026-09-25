import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  createObsidianMcpStorage,
  normalizeObsidianMcpUrl,
  OBSIDIAN_MCP_VAULT_MARKER_PATH,
  readObsidianMcpNotes,
  searchObsidianMcp,
  writeObsidianMcpNote,
  type ObsidianMcpOptions,
} from '../src/mcp.ts'

describe('Obsidian MCP read backend', () => {
  afterEach(() => { vi.restoreAllMocks() })
  let httpServer: Server
  let url: string
  const seenAuth: Array<string | undefined> = []
  const vaultMarker = {
    path: OBSIDIAN_MCP_VAULT_MARKER_PATH,
    markdown: '# Fixture vault identity\n\nfixture-id\n',
  }
  const notes = new Map<string, string>([
    [`${vaultMarker.path}.md`, vaultMarker.markdown],
    ['Hydra Website Knowledge/Imported/Test Cases/TC-0001.md', '# Complete MCP note\n\nExpected result: Payroll is listed.\n'],
  ])
  const seenReads: string[] = []
  const seenWrites: Array<{ path: string; content: string }> = []
  const searchResults = new Map<string, CallToolResult>()
  const readPayloads = new Map<string, unknown>()
  let writeAcknowledgment: unknown = { message: 'OK' }
  let preserveWrite = true
  const rankingPayload = [
    {
      filename: 'Hydra Website Knowledge/Imported/Test Cases/TC-0000.md',
      score: 200,
      matches: [{ context: 'Navigate to the Applications page, then click the Import button' }],
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      filename: `Hydra Website Knowledge/Imported/Features/noise-${index}.md`,
      score: 100 - index,
      matches: [{ context: 'Import Applications related link' }],
    })),
    {
      filename: 'Hydra Website Knowledge/Imported/Test Cases/TC-9999.md',
      score: 1,
      matches: [{ context: 'Import Applications' }],
    },
  ]

  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    seenAuth.push(req.headers.authorization)
    if (req.headers.authorization === 'Bearer rejected-token') {
      res.writeHead(401).end('Unauthorized')
      return
    }
    const server = new McpServer(
      { name: 'obsidian-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.registerTool('search_simple', {
      inputSchema: { query: z.string(), contextLength: z.number().optional() },
    }, async ({ query }) => searchResults.get(query) ?? ({
      content: [{
        type: 'text',
        text: query === 'invalid response'
          ? JSON.stringify({ invalid: true })
          : query === 'Import Applications'
            ? JSON.stringify(rankingPayload)
            : JSON.stringify([
              { filename: 'Other/private.md', score: 2, matches: ['must be filtered'] },
              {
                filename: 'Hydra Website Knowledge/Imported/Test Cases/TC-0001.md',
                score: 1,
                matches: [{ context: 'Payroll application' }],
              },
            ]),
      }],
    }))
    server.registerTool('vault_read', {
      inputSchema: { path: z.string() },
    }, async ({ path }) => {
      seenReads.push(path)
      if (readPayloads.has(path)) return { content: [{ type: 'text', text: JSON.stringify(readPayloads.get(path)) }] }
      const content = notes.get(path)
      if (content === undefined) throw new Error(`File not found: ${path}`)
      return {
        content: [{ type: 'text', text: JSON.stringify({ path, content }) }],
      }
    })
    server.registerTool('vault_write', {
      inputSchema: { path: z.string(), content: z.string() },
    }, async ({ path, content }) => {
      seenWrites.push({ path, content })
      notes.set(path, preserveWrite ? content : 'changed content')
      return { content: [{ type: 'text', text: JSON.stringify(writeAcknowledgment) }] }
    })
    const transport = new StreamableHTTPServerTransport({})
    res.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport as Transport)
    await transport.handleRequest(req, res)
  }

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      handleMcpRequest(req, res).catch((error: unknown) => {
        res.writeHead(500).end(String(error))
      })
    })
    const listening = Promise.withResolvers<undefined>()
    httpServer.listen(0, '127.0.0.1', () => { listening.resolve(undefined) })
    await listening.promise
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address')
    url = `http://127.0.0.1:${address.port}/mcp/`
  })

  afterAll(async () => {
    const closed = Promise.withResolvers<undefined>()
    httpServer.close(() => { closed.resolve(undefined) })
    await closed.promise
  })

  function options(
    resolveApiKey: () => Promise<string | undefined> = async () => 'test-token',
  ): ObsidianMcpOptions {
    return { url, timeoutMs: 5_000, resolveApiKey }
  }

  it('reads the MCP-side vault identity before authenticated search and exact note reads', async () => {
    const storage = createObsidianMcpStorage(options())
    await expect(storage.verifyVault()).resolves.toEqual(vaultMarker)
    await expect(storage.search('Payroll')).resolves.toEqual([{
      path: 'Hydra Website Knowledge/Imported/Test Cases/TC-0001',
      title: 'TC-0001',
      excerpt: '[{"context":"Payroll application"}]',
    }])
    await expect(storage.readNotes([
      'Hydra Website Knowledge/Imported/Test Cases/TC-0001',
    ])).resolves.toEqual([{
      path: 'Hydra Website Knowledge/Imported/Test Cases/TC-0001',
      markdown: '# Complete MCP note\n\nExpected result: Payroll is listed.\n',
    }])
    expect(seenReads).toContain(`${OBSIDIAN_MCP_VAULT_MARKER_PATH}.md`)
    expect(seenAuth.length).toBeGreaterThan(0)
    expect(seenAuth.every(value => value === 'Bearer test-token')).toBe(true)
  })

  it('reports an unavailable MCP for a missing credential or unavailable transport', async () => {
    const requestsBefore = seenAuth.length
    await expect(searchObsidianMcp(options(async () => undefined), 'Payroll')).resolves.toBeUndefined()
    expect(seenAuth).toHaveLength(requestsBefore)
    await expect(searchObsidianMcp({ ...options(), url: 'http://127.0.0.1:65534/mcp/' }, 'Payroll'))
      .resolves.toBeUndefined()
    await expect(searchObsidianMcp(options(), 'invalid response')).rejects.toThrow(/non-array result/)
  })

  it('returns undefined only when MCP reports one exact note missing', async () => {
    const storage = createObsidianMcpStorage(options())
    const existingPath = 'Hydra Website Knowledge/Imported/Test Cases/TC-0001'
    await expect(storage.readNote('Hydra Website Knowledge/Imported/Test Cases/TC-missing')).resolves.toBeUndefined()
    await expect(storage.readNote(existingPath)).resolves.toEqual({
      path: existingPath,
      markdown: '# Complete MCP note\n\nExpected result: Payroll is listed.\n',
    })
    await expect(createObsidianMcpStorage(options(async () => undefined)).readNote(existingPath))
      .rejects.toThrow(/unavailable/)
    await expect(createObsidianMcpStorage({ ...options(), url: 'http://127.0.0.1:65534/mcp/' }).readNote(existingPath))
      .rejects.toThrow(/unavailable/)
    await expect(createObsidianMcpStorage(options(async () => 'rejected-token')).readNote(existingPath))
      .rejects.toThrow(/401|Unauthorized/)
  })

  it('reranks the complete Obsidian hit set and keeps individual test cases', async () => {
    const results = await searchObsidianMcp(options(), 'Import Applications')
    expect(results).toHaveLength(6)
    expect(results?.[0]?.path).toBe('Hydra Website Knowledge/Imported/Test Cases/TC-9999')
  })

  it('fails closed for rejected authentication or a missing MCP vault marker', async () => {
    await expect(searchObsidianMcp(options(async () => 'rejected-token'), 'Payroll'))
      .rejects.toThrow(/401|Unauthorized/)
    notes.delete(`${OBSIDIAN_MCP_VAULT_MARKER_PATH}.md`)
    await expect(searchObsidianMcp(options(), 'Payroll')).rejects.toThrow(/vault_read failed/)
    notes.set(`${OBSIDIAN_MCP_VAULT_MARKER_PATH}.md`, vaultMarker.markdown)
  })

  it('writes one exact validated logical note through MCP and reads it back', async () => {
    const note = {
      path: 'Hydra Website Knowledge/Imported/Approved Knowledge/approved-fixture',
      markdown: '# Approved fixture\n\nExact content.\n',
    }
    const readsBefore = seenReads.length
    await expect(createObsidianMcpStorage(options()).writeNote(note)).resolves.toEqual(note)
    expect(seenWrites.at(-1)).toEqual({ path: `${note.path}.md`, content: note.markdown })
    expect(seenReads.slice(readsBefore)).toEqual(expect.arrayContaining([
      `${OBSIDIAN_MCP_VAULT_MARKER_PATH}.md`,
      `${note.path}.md`,
    ]))
    await expect(readObsidianMcpNotes(options(), [note.path])).resolves.toEqual([note])
    expect(() => writeObsidianMcpNote(options(), {
      path: OBSIDIAN_MCP_VAULT_MARKER_PATH,
      markdown: 'replacement',
    })).toThrow(/refuses to overwrite/)
  })

  it('accepts only the local Obsidian MCP endpoint shape', () => {
    expect(normalizeObsidianMcpUrl(url)).toBe(url)
    expect(() => normalizeObsidianMcpUrl('https://example.com/mcp/')).toThrow(/loopback/)
    expect(() => normalizeObsidianMcpUrl('http://127.0.0.1:27123/api/')).toThrow(/loopback/)
    expect(() => normalizeObsidianMcpUrl('not a URL')).toThrow('absolute HTTP(S) URL')
  })

  it.each([
    [{ isError: true, content: [{ type: 'text', text: 'provider failed' }] }, 'failed'],
    [{ content: [] }, 'invalid content batch'],
    [{ content: [{ type: 'text', text: '[]' }, { type: 'text', text: '[]' }] }, 'invalid content batch'],
    [{ content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] }, 'non-text content'],
    [{ content: [{ type: 'text', text: 'not JSON' }] }, 'invalid JSON text'],
  ] satisfies Array<[CallToolResult, string]>)('rejects a malformed search result: %j', async (result, message) => {
    searchResults.set('malformed reply', result)
    await expect(searchObsidianMcp(options(), 'malformed reply')).rejects.toThrow(message)
  })

  it.each([null, {}])('rejects malformed search hits: %j', async (hit) => {
    searchResults.set('malformed hits', { content: [{ type: 'text', text: JSON.stringify([hit]) }] })
    await expect(searchObsidianMcp(options(), 'malformed hits')).rejects.toThrow(/invalid hit|without filename/)
  })

  it('filters unsafe paths, vault identity, and duplicates, allowing absent match excerpts', async () => {
    searchResults.set('safe paths', { content: [{ type: 'text', text: JSON.stringify([
      { filename: `${OBSIDIAN_MCP_VAULT_MARKER_PATH}.md` },
      { filename: 'Hydra Website Knowledge/../outside.md' },
      { filename: 'Hydra Website Knowledge/valid.txt' },
      { filename: 'Hydra Website Knowledge/safe.md' },
      { filename: 'Hydra Website Knowledge/safe.md' },
    ]) }] })
    expect(await searchObsidianMcp(options(), 'safe paths')).toEqual([{ path: 'Hydra Website Knowledge/safe', title: 'safe', excerpt: '' }])
  })

  it.each([null, 'metadata', {}, { path: 'wrong.md', content: 'body' }])('refuses mismatched note metadata: %j', async (payload) => {
    const path = 'Hydra Website Knowledge/invalid'
    readPayloads.set(`${path}.md`, payload)
    await expect(readObsidianMcpNotes(options(), [path])).rejects.toThrow(/invalid metadata|mismatched content/)
  })

  it('refuses an empty vault identity marker', async () => {
    notes.set(`${vaultMarker.path}.md`, '  ')
    try {
      await expect(searchObsidianMcp(options(), 'Payroll')).rejects.toThrow('vault identity marker is empty')
    } finally { notes.set(`${vaultMarker.path}.md`, vaultMarker.markdown) }
  })

  it.each([null, 'OK', {}, { message: 'failed' }])('refuses an invalid write acknowledgment: %j', async (acknowledgment) => {
    writeAcknowledgment = acknowledgment
    try {
      await expect(writeObsidianMcpNote(options(), { path: 'Hydra Website Knowledge/proposal', markdown: 'approved' }))
        .rejects.toThrow('invalid acknowledgement')
    } finally { writeAcknowledgment = { message: 'OK' } }
  })

  it('requires exact readback after an acknowledged write', async () => {
    preserveWrite = false
    try {
      await expect(writeObsidianMcpNote(options(), { path: 'Hydra Website Knowledge/proposal', markdown: 'approved' }))
        .rejects.toThrow('did not preserve exact content')
    } finally { preserveWrite = true }
  })

  it('classifies timeout and aggregate connection failures without recursing through cyclic causes', async () => {
    const cycle = new Error('cyclic failure')
    cycle.cause = cycle
    for (const error of [cycle, 'opaque failure']) {
      vi.spyOn(Client.prototype, 'connect').mockRejectedValueOnce(error)
      await expect(searchObsidianMcp(options(), 'Payroll')).rejects.toBe(error)
    }
    for (const error of [
      new McpError(ErrorCode.RequestTimeout, 'request timed out'),
      new AggregateError([new Error('unknown'), Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })]),
    ]) {
      vi.spyOn(Client.prototype, 'connect').mockRejectedValueOnce(error)
      await expect(searchObsidianMcp(options(), 'Payroll')).resolves.toBeUndefined()
    }
  })
})
