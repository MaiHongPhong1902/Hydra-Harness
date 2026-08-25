/** Narrow graph storage adapter for Obsidian Local REST API's built-in MCP server. */

import { basename } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import {
  assertKnowledgeNoteBytes,
  GRAPH_ROOT,
  OBSIDIAN_MCP_VAULT_MARKER_PATH,
  searchTerms,
  validateKnowledgeNotePaths,
  type KnowledgeNote,
  type KnowledgeSearchResult,
} from './graph.ts'

export { OBSIDIAN_MCP_VAULT_MARKER_PATH } from './graph.ts'

/** Per-operation connection options; the credential resolver must not cache secrets. */
export interface ObsidianMcpOptions {
  readonly url: string
  readonly timeoutMs: number
  readonly resolveApiKey: () => Promise<string | undefined>
}

/** Bounded, graph-rooted storage backed by one authenticated Obsidian MCP operation at a time. */
export interface ObsidianMcpStorage {
  /** Read the MCP-side vault identity note. Undefined means MCP is unavailable. */
  verifyVault(): Promise<KnowledgeNote | undefined>
  /** Search the live Obsidian index. Undefined means MCP is unavailable. */
  search(query: string): Promise<KnowledgeSearchResult[] | undefined>
  /** Read one exact graph note; undefined means only that MCP reported the note missing. */
  readNote(path: string): Promise<KnowledgeNote | undefined>
  /** Read exact complete graph notes. Undefined means MCP is unavailable. */
  readNotes(paths: readonly string[]): Promise<KnowledgeNote[] | undefined>
  /** Overwrite one validated graph note and return its exact MCP readback. Undefined means MCP is unavailable. */
  writeNote(note: KnowledgeNote): Promise<KnowledgeNote | undefined>
}

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])
const MCP_NOTE_NOT_FOUND = Symbol('mcp-note-not-found')

/**
 * Validate a local-only Obsidian MCP endpoint before a bearer token can reach it.
 * @param value - Candidate Streamable HTTP endpoint.
 * @returns Canonical URL string.
 */
export function normalizeObsidianMcpUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('obsidian-website-knowledge: mcpUrl must be an absolute HTTP(S) URL')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.hostname !== '127.0.0.1'
    || url.username.length > 0
    || url.password.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || url.pathname !== '/mcp/') {
    throw new Error('obsidian-website-knowledge: mcpUrl must be a loopback http(s)://127.0.0.1:<port>/mcp/ endpoint')
  }
  return url.toString()
}

type ConnectedResult<Value> = Value | undefined

function isTransportUnavailable(error: unknown, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) return false
  seen.add(error)
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return true
  if (error instanceof AggregateError) return error.errors.some(item => isTransportUnavailable(item, seen))
  if (error === null || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  if (typeof record['code'] === 'string' && UNAVAILABLE_CODES.has(record['code'])) return true
  return isTransportUnavailable(record['cause'], seen)
}

/** Connect once for one MCP operation; undefined means the transport is unavailable. */
async function withClient<Value>(
  options: ObsidianMcpOptions,
  operation: (client: Client) => Promise<Value>,
): Promise<ConnectedResult<Value>> {
  const apiKey = await options.resolveApiKey()
  if (apiKey === undefined || apiKey.length === 0) return undefined
  const client = new Client({ name: 'bh-obsidian-website-knowledge', version: '0.1.0' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
  })
  try {
    // The SDK's concrete transport carries an optional `sessionId` that its
    // shared Transport type omits under exactOptionalPropertyTypes.
    await client.connect(transport as Transport, { timeout: options.timeoutMs })
  } catch (error) {
    try { await client.close() } catch { /* failed connection already owns no usable transport */ }
    if (isTransportUnavailable(error)) return undefined
    throw error
  }
  try {
    return await operation(client)
  } finally {
    try { await client.close() } catch { /* operation result remains authoritative after transport teardown */ }
  }
}

function logicalNotePath(path: string): string {
  const [logicalPath] = validateKnowledgeNotePaths([path])
  if (logicalPath === undefined) throw new Error(`invalid website knowledge note path: ${path}`)
  return logicalPath
}

async function readMcpNote(
  client: Client,
  options: ObsidianMcpOptions,
  path: string,
): Promise<KnowledgeNote> {
  const note = await maybeReadMcpNote(client, options, path)
  if (note === undefined) throw new Error('Obsidian MCP vault_read failed')
  return note
}

function isMcpNoteNotFound(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  const record = result as Record<string, unknown>
  if (record['isError'] !== true || !Array.isArray(record['content'])) return false
  return record['content'].some(block => block !== null
    && typeof block === 'object'
    && (block as Record<string, unknown>)['type'] === 'text'
    && typeof (block as Record<string, unknown>)['text'] === 'string'
    && /\bnot found\b/i.test((block as Record<string, string>)['text'] ?? ''))
}

async function maybeReadMcpNote(
  client: Client,
  options: ObsidianMcpOptions,
  path: string,
): Promise<KnowledgeNote | undefined> {
  const logicalPath = logicalNotePath(path)
  const expectedPath = `${logicalPath}.md`
  const result = await client.callTool(
    { name: 'vault_read', arguments: { path: expectedPath } },
    undefined,
    { timeout: options.timeoutMs },
  )
  if (isMcpNoteNotFound(result)) return undefined
  const payload = toolJson(result, 'vault_read')
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`Obsidian MCP vault_read returned invalid metadata for ${logicalPath}`)
  }
  const record = payload as Record<string, unknown>
  const markdown = record['content']
  if (record['path'] !== expectedPath || typeof markdown !== 'string') {
    throw new Error(`Obsidian MCP vault_read returned mismatched content for ${logicalPath}`)
  }
  const note = { path: logicalPath, markdown }
  assertKnowledgeNoteBytes([note])
  return note
}

async function verifyMcpVault(client: Client, options: ObsidianMcpOptions): Promise<KnowledgeNote> {
  const marker = await readMcpNote(client, options, OBSIDIAN_MCP_VAULT_MARKER_PATH)
  if (marker.markdown.trim().length === 0) throw new Error('Obsidian MCP vault identity marker is empty')
  return marker
}

async function withVerifiedMcpVault<Value>(
  options: ObsidianMcpOptions,
  operation: (client: Client) => Promise<Value>,
): Promise<ConnectedResult<Value>> {
  return withClient(options, async (client) => {
    await verifyMcpVault(client, options)
    return operation(client)
  })
}

async function readOneMcpNote(options: ObsidianMcpOptions, path: string): Promise<KnowledgeNote | undefined> {
  const logicalPath = logicalNotePath(path)
  const result = await withVerifiedMcpVault<KnowledgeNote | typeof MCP_NOTE_NOT_FOUND>(options, async (client) => {
    return await maybeReadMcpNote(client, options, logicalPath) ?? MCP_NOTE_NOT_FOUND
  })
  if (result === undefined) throw new Error(`Obsidian MCP vault_read is unavailable for ${logicalPath}`)
  return result === MCP_NOTE_NOT_FOUND ? undefined : result
}

function validateWritableMcpNote(note: KnowledgeNote): KnowledgeNote {
  const path = logicalNotePath(note.path)
  if (path === OBSIDIAN_MCP_VAULT_MARKER_PATH) {
    throw new Error('Obsidian MCP refuses to overwrite the vault identity marker')
  }
  if (typeof note.markdown !== 'string') throw new Error(`invalid website knowledge note content for ${path}`)
  const validated = { path, markdown: note.markdown }
  assertKnowledgeNoteBytes([validated])
  return validated
}

async function writeMcpNote(
  client: Client,
  options: ObsidianMcpOptions,
  note: KnowledgeNote,
): Promise<KnowledgeNote> {
  const expectedPath = `${note.path}.md`
  const payload = toolJson(await client.callTool(
    { name: 'vault_write', arguments: { path: expectedPath, content: note.markdown } },
    undefined,
    { timeout: options.timeoutMs },
  ), 'vault_write')
  if (payload === null || typeof payload !== 'object' || (payload as Record<string, unknown>)['message'] !== 'OK') {
    throw new Error(`Obsidian MCP vault_write returned an invalid acknowledgement for ${note.path}`)
  }
  const readback = await readMcpNote(client, options, note.path)
  if (readback.markdown !== note.markdown) {
    throw new Error(`Obsidian MCP vault_write did not preserve exact content for ${note.path}`)
  }
  return readback
}

function toolJson(result: unknown, toolName: string): unknown {
  if (result === null || typeof result !== 'object') {
    throw new Error(`Obsidian MCP ${toolName} returned an invalid result`)
  }
  const record = result as Record<string, unknown>
  if (record['isError'] === true) throw new Error(`Obsidian MCP ${toolName} failed`)
  const content = record['content']
  if (!Array.isArray(content) || content.length !== 1) {
    throw new Error(`Obsidian MCP ${toolName} returned an invalid content batch`)
  }
  const block = content[0]
  if (block === null || typeof block !== 'object'
    || (block as Record<string, unknown>)['type'] !== 'text'
    || typeof (block as Record<string, unknown>)['text'] !== 'string') {
    throw new Error(`Obsidian MCP ${toolName} returned non-text content`)
  }
  try {
    return JSON.parse((block as Record<string, string>)['text'] ?? '') as unknown
  } catch {
    throw new Error(`Obsidian MCP ${toolName} returned invalid JSON text`)
  }
}

function searchExcerpt(value: unknown): string {
  let compact: string
  try {
    compact = JSON.stringify(value)?.replace(/\s+/g, ' ').trim() ?? ''
  } catch {
    compact = ''
  }
  return compact.slice(0, 600)
}

function logicalSearchPath(filename: string): string | undefined {
  const normalized = filename.replaceAll('\\', '/')
  if (!normalized.startsWith(`${GRAPH_ROOT}/`) || !normalized.toLowerCase().endsWith('.md')) return undefined
  try {
    const path = validateKnowledgeNotePaths([normalized.slice(0, -3)])[0]
    return path === OBSIDIAN_MCP_VAULT_MARKER_PATH ? undefined : path
  } catch {
    // Obsidian searches the whole vault; malformed or out-of-root hits are not knowledge candidates.
    return undefined
  }
}

/**
 * Search the live Obsidian index. Undefined means the MCP transport was unavailable.
 * @param options - Connection and credential resolver.
 * @param query - Focused vault search query.
 * @returns Ranked knowledge hits, an empty valid result, or undefined when MCP is unavailable.
 */
export function searchObsidianMcp(
  options: ObsidianMcpOptions,
  query: string,
): Promise<KnowledgeSearchResult[] | undefined> {
  return withVerifiedMcpVault(options, async (client) => {
    const terms = searchTerms(query)
    const payload = toolJson(await client.callTool(
      { name: 'search_simple', arguments: { query, contextLength: 300 } },
      undefined,
      { timeout: options.timeoutMs },
    ), 'search_simple')
    if (!Array.isArray(payload)) throw new Error('Obsidian MCP search_simple returned a non-array result')
    const results: Array<KnowledgeSearchResult & {
      evidenceScore: number
      phraseScore: number
      termScore: number
      titleScore: number
    }> = []
    const seen = new Set<string>()
    for (const item of payload) {
      if (item === null || typeof item !== 'object') throw new Error('Obsidian MCP search_simple returned an invalid hit')
      const record = item as Record<string, unknown>
      if (typeof record['filename'] !== 'string') throw new Error('Obsidian MCP search_simple returned a hit without filename')
      const path = logicalSearchPath(record['filename'])
      if (path === undefined || seen.has(path)) continue
      seen.add(path)
      const title = basename(path)
      const excerpt = searchExcerpt(record['matches'])
      const lowered = `${record['filename']} ${excerpt}`.toLowerCase()
      const loweredTitle = title.toLowerCase()
      const phrase = query.trim().toLowerCase()
      results.push({
        path,
        title,
        excerpt,
        phraseScore: Number(lowered.includes(phrase)),
        termScore: terms.reduce((total, term) => total + Number(lowered.includes(term)), 0),
        titleScore: terms.reduce((total, term) => total + Number(loweredTitle.includes(term)), 0),
        evidenceScore: path.includes('/Test Cases/') ? 2 : path.includes('/Features/') ? 1 : 0,
      })
    }
    return results
      .sort((left, right) => right.phraseScore - left.phraseScore
        || right.termScore - left.termScore
        || right.evidenceScore - left.evidenceScore
        || right.titleScore - left.titleScore
        || left.path.localeCompare(right.path))
      .slice(0, 8)
      .map(({
        phraseScore: _phraseScore, termScore: _termScore, titleScore: _titleScore,
        evidenceScore: _evidenceScore, ...result
      }) => result)
  })
}

/**
 * Read exact complete notes through Obsidian MCP. Undefined means transport unavailable.
 * @param options - Connection and credential resolver.
 * @param paths - Exact extensionless knowledge paths.
 * @returns Complete order-preserving notes or undefined when MCP is unavailable.
 */
export function readObsidianMcpNotes(
  options: ObsidianMcpOptions,
  paths: readonly string[],
): Promise<KnowledgeNote[] | undefined> {
  const uniquePaths = validateKnowledgeNotePaths(paths)
  return withVerifiedMcpVault(options, async (client) => {
    const notes = await Promise.all(uniquePaths.map(path => readMcpNote(client, options, path)))
    assertKnowledgeNoteBytes(notes)
    return notes
  })
}

/**
 * Write one exact graph-rooted Markdown note through Obsidian MCP.
 * @param options - Connection and credential resolver.
 * @param note - Extensionless logical note and complete Markdown content.
 * @returns Exact MCP readback or undefined when MCP is unavailable.
 */
export function writeObsidianMcpNote(
  options: ObsidianMcpOptions,
  note: KnowledgeNote,
): Promise<KnowledgeNote | undefined> {
  const validated = validateWritableMcpNote(note)
  return withVerifiedMcpVault(options, client => writeMcpNote(client, options, validated))
}

/**
 * Create a narrow MCP storage helper for graph operations.
 * @param options - Connection and credential resolver.
 * @returns Authenticated, marker-verified Obsidian graph storage.
 */
export function createObsidianMcpStorage(options: ObsidianMcpOptions): ObsidianMcpStorage {
  return {
    verifyVault: () => withClient(options, client => verifyMcpVault(client, options)),
    search: query => searchObsidianMcp(options, query),
    readNote: path => readOneMcpNote(options, path),
    readNotes: paths => readObsidianMcpNotes(options, paths),
    writeNote: note => writeObsidianMcpNote(options, note),
  }
}
