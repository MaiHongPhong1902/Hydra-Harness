/**
 * Obsidian knowledge graph retrieval and approval-gated writes. The local
 * adapter exists only for isolated tests; production uses Obsidian MCP
 * storage.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@hydraharness/harness-atomic-write'

/** Existing vault folder retained as the contained graph root. */
export const GRAPH_ROOT = 'Hydra Website Knowledge'
/** Extensionless identity note that binds MCP operations to the intended vault. */
export const OBSIDIAN_MCP_VAULT_MARKER_PATH = `${GRAPH_ROOT}/Hydra MCP Vault Identity`
/** Maximum exact paths accepted by one complete-note read. */
export const MAX_READ_NOTES = 32
/** Maximum UTF-8 bytes returned by one complete-note read. */
export const MAX_READ_BYTES = 64 * 1024
/** Maximum ranked contextual matches returned by recall. */
export const MAX_RECALL_MATCHES = 6
/** Maximum path-only wikilink neighbors returned by recall. */
export const MAX_RELATED_NOTES = 32
const MAX_RECALL_SEEDS = 3
const MAX_RECALL_EXCERPT = 320

/** Local filesystem settings used only by the local graph test adapter. */
export interface LocalObsidianKnowledgeSettings {
  readonly vaultPath: string
}

/** Storage owned by one configured Obsidian vault. */
export interface ObsidianKnowledgeStorage {
  /** Search complete persisted knowledge. */
  search(query: string): Promise<KnowledgeSearchResult[]>
  /** Read complete exact persisted knowledge notes. */
  readNotes(paths: readonly string[]): Promise<KnowledgeNote[]>
  /** Write one extensionless logical note path. */
  write(path: string, content: string): Promise<void>
}

/** One bounded full-text hit from the local website-knowledge folder. */
export interface KnowledgeSearchResult {
  readonly path: string
  readonly title: string
  readonly excerpt: string
}

/** One complete persisted Markdown note selected by its exact search-result path. */
export interface KnowledgeNote {
  readonly path: string
  readonly markdown: string
}

/** One explicit Obsidian wikilink discovered from a ranked seed note. */
export interface KnowledgeRelation {
  readonly path: string
  readonly title: string
  readonly sourcePath: string
}

/** Token-bounded search context plus exact graph neighbors available for batch reading. */
export interface KnowledgeRecall {
  readonly matches: readonly KnowledgeSearchResult[]
  readonly related: readonly KnowledgeRelation[]
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function text(value: string, limit = 300): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\[\]]/g, ' ').trim().slice(0, limit)
}

function yaml(value: string): string {
  return JSON.stringify(value)
}

/**
 * Normalize one focused recall query into distinct searchable terms.
 * @param query - User intent or knowledge phrase to recall.
 * @returns Lowercase terms in first-occurrence order.
 */
export function searchTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase()
  if (normalized.length < 2 || normalized.length > 160) {
    throw new Error('Obsidian knowledge query must contain 2 to 160 characters')
  }
  const terms = [...new Set(normalized.split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length > 1))]
  if (terms.length === 0) throw new Error('Obsidian knowledge query must contain a searchable term')
  return terms
}

/**
 * Validate and deduplicate exact persisted-note paths in first-occurrence order.
 * @param paths - Candidate extensionless paths below {@link GRAPH_ROOT}.
 * @returns Safe logical paths ready for either the local or MCP reader.
 */
export function validateKnowledgeNotePaths(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > MAX_READ_NOTES) {
    throw new Error(`Obsidian knowledge note read requires 1 to ${MAX_READ_NOTES} paths`)
  }
  return [...new Set(paths.map((path) => {
    const value = path.trim()
    const segments = value.split('/')
    if (value.length === 0
      || value !== path
      || value.includes('\\')
      || value.includes('\0')
      || value.toLowerCase().endsWith('.md')
      || segments.length < 2
      || segments[0] !== GRAPH_ROOT
      || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new Error(`invalid Obsidian knowledge note path: ${path}`)
    }
    return value
  }))]
}

/**
 * Enforce the complete Markdown payload limit after reading either backend.
 * @param notes - Complete note batch to admit.
 */
export function assertKnowledgeNoteBytes(notes: readonly KnowledgeNote[]): void {
  const bytes = notes.reduce((total, note) => total + Buffer.byteLength(note.markdown, 'utf8'), 0)
  if (bytes > MAX_READ_BYTES) {
    throw new Error(`Obsidian knowledge note batch exceeds ${MAX_READ_BYTES} bytes; split the batch`)
  }
}

function excerpt(markdown: string, terms: readonly string[]): string {
  const compact = markdown.replace(/\s+/g, ' ').trim()
  const lowercase = compact.toLowerCase()
  const firstMatch = Math.min(...terms.map((term) => {
    const index = lowercase.indexOf(term)
    return index === -1 ? Number.POSITIVE_INFINITY : index
  }))
  const startAt = Number.isFinite(firstMatch) ? Math.max(0, firstMatch - 180) : 0
  return `${startAt > 0 ? '…' : ''}${compact.slice(startAt, startAt + MAX_RECALL_EXCERPT)}${startAt + MAX_RECALL_EXCERPT < compact.length ? '…' : ''}`
}

function knowledgeLinkPath(source: KnowledgeNote, target: string): string | undefined {
  const [rawTarget = ''] = target.split('#', 1)
  const clean = rawTarget.trim().replace(/\.md$/i, '')
  if (clean.length === 0 || clean.startsWith('/')) return undefined
  let path: string
  if (clean.startsWith(`${GRAPH_ROOT}/`)) {
    path = clean
  } else if (clean.startsWith('./') || clean.startsWith('../')) {
    path = posix.normalize(posix.join(posix.dirname(source.path), clean))
  } else if (!clean.includes('/')) {
    path = posix.join(posix.dirname(source.path), clean)
  } else {
    const collectionNote = /^type:\s+(?:uat-feature|uat-test-case)\s*$/m.test(source.markdown)
    const base = collectionNote ? posix.dirname(posix.dirname(source.path)) : posix.dirname(source.path)
    path = posix.join(base, clean)
  }
  try {
    return validateKnowledgeNotePaths([path])[0]
  } catch {
    return undefined
  }
}

/**
 * Follow explicit wikilinks without returning linked note bodies.
 * @param notes - Complete ranked seed notes whose links may be expanded.
 * @param exclude - Exact paths already represented by recall matches.
 * @returns Deduplicated one-hop neighbors in authored order.
 */
export function relatedKnowledgeNotes(
  notes: readonly KnowledgeNote[],
  exclude: readonly string[] = [],
): KnowledgeRelation[] {
  const related: KnowledgeRelation[] = []
  const seen = new Set([...notes.map(note => note.path), ...exclude])
  for (const note of notes) {
    for (const match of note.markdown.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const body = match[1]
      /* v8 ignore next -- the wikilink expression always captures its non-empty body. */
      if (body === undefined) continue
      const [target = '', alias] = body.split('|', 2)
      const path = knowledgeLinkPath(note, target)
      if (path === undefined || path === OBSIDIAN_MCP_VAULT_MARKER_PATH || seen.has(path)) continue
      seen.add(path)
      related.push({ path, title: alias?.trim() || posix.basename(path), sourcePath: note.path })
      if (related.length === MAX_RELATED_NOTES) return related
    }
  }
  return related
}

function searchRank(markdown: string, terms: readonly string[]): { termScore: number; titleScore: number; evidenceScore: number } {
  const lowered = markdown.toLowerCase()
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.toLowerCase() ?? ''
  return {
    termScore: terms.reduce((total, term) => total + Number(lowered.includes(term)), 0),
    titleScore: terms.reduce((total, term) => total + Number(title.includes(term)), 0),
    evidenceScore: /^type:\s+uat-test-case\s*$/m.test(markdown) ? 2 : /^type:\s+uat-feature\s*$/m.test(markdown) ? 1 : 0,
  }
}

async function existingText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Local filesystem adapter retained for isolated graph tests. */
class LocalVaultStorage implements ObsidianKnowledgeStorage {
  constructor(private readonly vaultPath: string) {}

  async write(path: string, content: string): Promise<void> {
    const absolute = this.absolutePath(path)
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
    await writeFileAtomic(absolute, content, { mode: 0o600, dirMode: 0o700 })
  }

  async search(query: string): Promise<KnowledgeSearchResult[]> {
    const terms = searchTerms(query)
    // Bounded O(n) Markdown scan; add an index only if vault search latency is measured as a problem.
    const files = await this.markdownFiles(join(this.vaultPath, GRAPH_ROOT), 5_000)
    const matches: Array<KnowledgeSearchResult & { termScore: number; titleScore: number; evidenceScore: number }> = []
    for (const file of files) {
      const path = relative(this.vaultPath, file).replaceAll('\\', '/').replace(/\.md$/i, '')
      if (path === OBSIDIAN_MCP_VAULT_MARKER_PATH) continue
      const markdown = await existingText(file)
      const rank = searchRank(markdown, terms)
      if (rank.termScore === 0) continue
      matches.push({
        path,
        title: markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(file, '.md'),
        excerpt: excerpt(markdown, terms),
        ...rank,
      })
    }
    return matches
      .sort((left, right) => right.termScore - left.termScore
        || right.titleScore - left.titleScore
        || right.evidenceScore - left.evidenceScore
        || left.path.localeCompare(right.path))
      .slice(0, 8)
      .map(({ termScore: _termScore, titleScore: _titleScore, evidenceScore: _evidenceScore, ...match }) => match)
  }

  async readNotes(paths: readonly string[]): Promise<KnowledgeNote[]> {
    const uniquePaths = validateKnowledgeNotePaths(paths)
    const root = await realpath(join(this.vaultPath, GRAPH_ROOT))
    const notes: KnowledgeNote[] = []
    let totalBytes = 0
    for (const path of uniquePaths) {
      let target: string
      try {
        target = await realpath(this.absolutePath(path))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Obsidian knowledge note not found: ${path}`)
        }
        throw error
      }
      const fromRoot = relative(root, target)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw new Error(`Obsidian knowledge note is outside ${GRAPH_ROOT}: ${path}`)
      }
      const info = await stat(target)
      if (!info.isFile()) throw new Error(`Obsidian knowledge note is not a file: ${path}`)
      totalBytes += info.size
      if (totalBytes > MAX_READ_BYTES) {
        throw new Error(`Obsidian knowledge note batch exceeds ${MAX_READ_BYTES} bytes; split the batch`)
      }
      notes.push({ path, markdown: await readFile(target, 'utf8') })
      assertKnowledgeNoteBytes(notes)
    }
    return notes
  }

  private async markdownFiles(root: string, limit: number): Promise<string[]> {
    const files: string[] = []
    const visit = async (directory: string): Promise<void> => {
      /* v8 ignore next -- the initial count is zero and every recursive call follows the loop's limit check. */
      if (files.length >= limit) return
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        if (files.length >= limit) return
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await visit(path)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(path)
      }
    }
    await visit(root)
    return files
  }

  private absolutePath(path: string): string {
    return join(this.vaultPath, `${path}.md`)
  }
}

/**
 * Create a local graph only for isolated graph tests.
 * @param settings - Contained fixture vault settings.
 * @returns A graph backed by the local test-only storage adapter.
 */
export function createLocalObsidianKnowledgeGraph(settings: LocalObsidianKnowledgeSettings): ObsidianKnowledgeGraph {
  const vaultPath = settings.vaultPath.trim()
  if (!isAbsolute(vaultPath) || resolve(vaultPath) === parse(resolve(vaultPath)).root) {
    throw new Error('obsidian-knowledge: vaultPath must be an absolute non-root directory')
  }
  return new ObsidianKnowledgeGraph(new LocalVaultStorage(resolve(vaultPath)))
}

/** One Obsidian graph backed by the configured storage provider. */
export class ObsidianKnowledgeGraph {
  constructor(private readonly storage: ObsidianKnowledgeStorage) {}

  /**
   * Read complete persisted notes by the exact extensionless paths returned by search.
   * The whole batch fails rather than returning partial or truncated source evidence.
   * @param paths - One to 32 logical paths below `Hydra Website Knowledge/`.
   * @returns Complete Markdown notes in first-occurrence request order.
   */
  async readNotes(paths: readonly string[]): Promise<KnowledgeNote[]> {
    return this.storage.readNotes(paths)
  }

  /**
   * Recall concise matches and explicit graph neighbors below the knowledge root.
   * @param query - Focused feature, control, or test-case terms.
   * @returns At most six excerpts and 32 linked exact paths.
   */
  async recall(query: string): Promise<KnowledgeRecall> {
    const terms = searchTerms(query)
    const matches = (await this.storage.search(query)).slice(0, MAX_RECALL_MATCHES)
    const seedPaths = matches.slice(0, MAX_RECALL_SEEDS).map(match => match.path)
    const seeds = seedPaths.length === 0 ? [] : await this.storage.readNotes(seedPaths)
    const seedByPath = new Map(seeds.map(note => [note.path, note]))
    return {
      matches: matches.map((match) => {
        const seed = seedByPath.get(match.path)
        return { ...match, excerpt: seed === undefined ? match.excerpt : excerpt(seed.markdown, terms) }
      }),
      related: relatedKnowledgeNotes(seeds, matches.map(match => match.path)),
    }
  }

  /**
   * Validate an approved proposal before it is committed.
   * @param title - Short proposal title.
   * @param content - Approved test knowledge or coverage decision.
   * @param evidence - User context and source-note references.
   */
  validateApproved(title: string, content: string, evidence: string): void {
    if (text(title, 180).length === 0 || content.trim().length === 0 || evidence.trim().length === 0) {
      throw new Error('approved knowledge requires a title, content, and evidence')
    }
  }

  /**
   * Persist a user-approved proposal.
   * @param title - Short proposal title.
   * @param content - Approved test knowledge or coverage decision.
   * @param evidence - User context and source-note references.
   * @returns Logical note path beneath the vault-owned graph root.
   */
  async saveApproved(title: string, content: string, evidence: string): Promise<string> {
    this.validateApproved(title, content, evidence)
    const cleanTitle = text(title, 180)
    const cleanContent = content.trim()
    const cleanEvidence = evidence.trim()
    const id = `approved-${digest(`${cleanTitle}\n${cleanContent}\n${cleanEvidence}`)}`
    const path = `${GRAPH_ROOT}/Approved Knowledge/${id}`
    await this.storage.write(path, [
      '---',
      'type: approved-test-knowledge',
      'provenance: user-approved-agent-proposal',
      `approved_at: ${yaml(new Date().toISOString())}`,
      '---',
      '',
      `# ${cleanTitle}`,
      '',
      '## Evidence',
      '',
      cleanEvidence,
      '',
      '## Approved knowledge',
      '',
      cleanContent,
      '',
    ].join('\n'))
    return path
  }
}
