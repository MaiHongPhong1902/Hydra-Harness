/**
 * Markdown graph rendering for observed browser pages. The Browser tool's text
 * DOM is evidence, not a selector API: this module records only its visible
 * controls and observed transitions. The local adapter below exists only for
 * isolated graph tests; the plugin uses Obsidian MCP storage.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@bosch/bh-atomic-write'
import type { BrowserToolValue } from '@bosch/bh-tool-browser'

export const GRAPH_ROOT = 'BH Website Knowledge'
export const OBSIDIAN_MCP_VAULT_MARKER_PATH = `${GRAPH_ROOT}/BH MCP Vault Identity`
export const MAX_READ_NOTES = 32
export const MAX_READ_BYTES = 64 * 1024
const ACTIONS_START = '<!-- bh-actions:start -->'
const ACTIONS_END = '<!-- bh-actions:end -->'

/** Optional user settings that activate one Obsidian website graph. */
export interface WebsiteKnowledgeSettings {
  /** Exact hostname whose browser observations may enter the vault. */
  targetDomain?: string
}

/** Validated settings required for a graph write or read. */
export interface ResolvedWebsiteKnowledgeSettings {
  readonly targetDomain: string
}

/** Local filesystem settings used only by the local graph test adapter. */
export interface LocalWebsiteKnowledgeSettings extends ResolvedWebsiteKnowledgeSettings {
  readonly vaultPath: string
}

/** Storage owned by one configured Obsidian vault. */
export interface WebsiteKnowledgeStorage {
  /** Read an extensionless logical note path, returning empty text when absent. */
  read(path: string): Promise<string>
  /** Write one extensionless logical note path. */
  write(path: string, content: string): Promise<void>
  /** Update one extensionless logical note path from its current text. */
  update(path: string, render: (current: string) => string): Promise<void>
  /** Search complete persisted knowledge. */
  search(query: string): Promise<KnowledgeSearchResult[]>
  /** Read complete exact persisted knowledge notes. */
  readNotes(paths: readonly string[]): Promise<KnowledgeNote[]>
}

/** One visible interactive control parsed from BH's Browser text DOM. */
export interface ControlRecord {
  readonly id: string
  readonly index: number
  readonly depth: number
  readonly tag: string
  readonly label: string
  readonly descriptor: string
}

/** One observed Browser page and its currently visible controls. */
export interface PageRecord {
  readonly id: string
  readonly url: string
  readonly title: string
  readonly header: string
  readonly footer: string
  readonly truncated: boolean
  readonly controls: readonly ControlRecord[]
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

/**
 * Return the exact HTTP(S) hostname, or undefined for any other URL.
 * @param url - Candidate URL to classify.
 * @returns Its lowercase hostname when it is an absolute HTTP(S) URL.
 */
export function hostnameOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.hostname.toLowerCase()
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Normalize a configured hostname and reject origins, paths, ports, and credentials.
 * @param value - User-supplied hostname configuration.
 * @returns The lowercase canonical hostname.
 */
export function normalizeTargetDomain(value: string): string {
  const input = value.trim().toLowerCase()
  if (input.length === 0 || /[/:?#@]/.test(input)) {
    throw new Error('obsidian-website-knowledge: targetDomain must be one hostname without a scheme, port, or path')
  }
  let hostname: string
  try {
    hostname = new URL(`https://${input}`).hostname.toLowerCase()
  } catch {
    throw new Error('obsidian-website-knowledge: targetDomain must be a valid hostname')
  }
  if (hostname !== input) {
    throw new Error('obsidian-website-knowledge: targetDomain must be a canonical hostname')
  }
  return hostname
}

/**
 * Validate an optional settings section; an entirely absent section keeps the feature inactive.
 * @param settings - Unresolved configuration from the composition and user settings layers.
 * @returns Validated settings, or undefined when the feature is inactive.
 */
export function resolveSettings(settings: WebsiteKnowledgeSettings): ResolvedWebsiteKnowledgeSettings | undefined {
  const targetDomain = settings.targetDomain?.trim()
  if (targetDomain === undefined) return undefined
  return { targetDomain: normalizeTargetDomain(targetDomain) }
}

/**
 * Apply the exact-host gate. Subdomains and lookalike hosts never match.
 * @param url - Browser URL to check.
 * @param targetDomain - Canonical configured hostname.
 * @returns Whether the URL is an HTTP(S) URL on the exact target hostname.
 */
export function matchesTargetDomain(url: string, targetDomain: string): boolean {
  return hostnameOf(url) === targetDomain
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

function noteLink(path: string, label?: string): string {
  return `[[${path}${label === undefined || label.length === 0 ? '' : `|${text(label, 120)}`}]]`
}

export function searchTerms(query: string): string[] {
  const normalized = query.trim().toLowerCase()
  if (normalized.length < 2 || normalized.length > 160) {
    throw new Error('website knowledge search query must contain 2 to 160 characters')
  }
  const terms = [...new Set(normalized.split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length > 1))]
  if (terms.length === 0) throw new Error('website knowledge search query must contain a searchable term')
  return terms
}

/**
 * Validate and deduplicate exact persisted-note paths in first-occurrence order.
 * @param paths - Candidate extensionless paths below {@link GRAPH_ROOT}.
 * @returns Safe logical paths ready for either the local or MCP reader.
 */
export function validateKnowledgeNotePaths(paths: readonly string[]): string[] {
  if (paths.length === 0 || paths.length > MAX_READ_NOTES) {
    throw new Error(`website knowledge note read requires 1 to ${MAX_READ_NOTES} paths`)
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
      throw new Error(`invalid website knowledge note path: ${path}`)
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
    throw new Error(`website knowledge note batch exceeds ${MAX_READ_BYTES} bytes; split the batch`)
  }
}

function excerpt(markdown: string, terms: readonly string[]): string {
  const compact = markdown.replace(/\s+/g, ' ').trim()
  const lowercase = compact.toLowerCase()
  const startAt = Math.max(0, Math.min(...terms.map((term) => {
    const index = lowercase.indexOf(term)
    return index === -1 ? Number.POSITIVE_INFINITY : index
  })) - 180)
  return `${startAt > 0 ? '…' : ''}${compact.slice(startAt, startAt + 600)}${startAt + 600 < compact.length ? '…' : ''}`
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

function extractActionLines(markdown: string): string[] {
  const start = markdown.indexOf(ACTIONS_START)
  const end = markdown.indexOf(ACTIONS_END)
  if (start === -1 || end === -1 || end < start) return []
  return markdown.slice(start + ACTIONS_START.length, end)
    .split('\n')
    .filter(line => line.startsWith('- [['))
}

async function existingText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Parse the visible interactive-element lines that BH's Browser tool returned.
 * @param value - Current Browser tool value.
 * @param pageId - Stable page-note identity used to derive control-note identities.
 * @returns One record per visible interactive element line.
 */
export function controlsFrom(value: BrowserToolValue, pageId: string): ControlRecord[] {
  const controls: ControlRecord[] = []
  for (const line of value.content.split('\n')) {
    const match = /^(\t*)\[(\d+)\]<([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>(.*)$/.exec(line)
    if (match === null) continue
    const indentation = match[1] ?? ''
    const indexText = match[2] ?? ''
    const tag = match[3] ?? ''
    const tail = match[4] ?? ''
    const descriptor = text(line, 500)
    const label = text(tail.replace(/<[^>]*>/g, ''), 160) || tag
    controls.push({
      id: `control-${pageId}-${digest(`${indentation.length}:${descriptor}`)}`,
      index: Number(indexText),
      depth: indentation.length,
      tag: tag.toLowerCase(),
      label,
      descriptor,
    })
  }
  return controls
}

/** Local filesystem adapter retained for isolated graph tests. */
class LocalVaultStorage implements WebsiteKnowledgeStorage {
  constructor(private readonly vaultPath: string) {}

  async read(path: string): Promise<string> {
    return existingText(this.absolutePath(path))
  }

  async write(path: string, content: string): Promise<void> {
    const absolute = this.absolutePath(path)
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
    await writeFileAtomic(absolute, content, { mode: 0o600, dirMode: 0o700 })
  }

  async update(path: string, render: (current: string) => string): Promise<void> {
    const absolute = this.absolutePath(path)
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
    await withFileLock(absolute, async () => {
      await writeFileAtomic(absolute, render(await existingText(absolute)), { mode: 0o600, dirMode: 0o700 })
    })
  }

  async search(query: string): Promise<KnowledgeSearchResult[]> {
    const terms = searchTerms(query)
    // ponytail: bounded O(n) Markdown scan; add an index only if vault search latency is measured as a problem.
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
          throw new Error(`website knowledge note not found: ${path}`)
        }
        throw error
      }
      const fromRoot = relative(root, target)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw new Error(`website knowledge note is outside ${GRAPH_ROOT}: ${path}`)
      }
      const info = await stat(target)
      if (!info.isFile()) throw new Error(`website knowledge note is not a file: ${path}`)
      totalBytes += info.size
      if (totalBytes > MAX_READ_BYTES) {
        throw new Error(`website knowledge note batch exceeds ${MAX_READ_BYTES} bytes; split the batch`)
      }
      notes.push({ path, markdown: await readFile(target, 'utf8') })
      assertKnowledgeNoteBytes(notes)
    }
    return notes
  }

  private async markdownFiles(root: string, limit: number): Promise<string[]> {
    const files: string[] = []
    const visit = async (directory: string): Promise<void> => {
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

/** Create a local graph only for isolated graph tests. */
export function createLocalObsidianWebsiteGraph(settings: LocalWebsiteKnowledgeSettings): ObsidianWebsiteGraph {
  const vaultPath = settings.vaultPath.trim()
  if (!isAbsolute(vaultPath) || resolve(vaultPath) === parse(resolve(vaultPath)).root) {
    throw new Error('obsidian-website-knowledge: vaultPath must be an absolute non-root directory')
  }
  return new ObsidianWebsiteGraph(
    { targetDomain: normalizeTargetDomain(settings.targetDomain) },
    new LocalVaultStorage(resolve(vaultPath)),
  )
}

/** One Obsidian graph backed by the configured storage provider. */
export class ObsidianWebsiteGraph {
  private readonly logicalRoot: string

  constructor(
    readonly settings: ResolvedWebsiteKnowledgeSettings,
    private readonly storage: WebsiteKnowledgeStorage,
  ) {
    this.logicalRoot = `${GRAPH_ROOT}/${settings.targetDomain}`
  }

  /**
   * Derive one page record from a Browser value without performing I/O.
   * @param value - Browser output to persist.
   * @returns The stable page record and its visible controls.
   */
  page(value: BrowserToolValue): PageRecord {
    const id = `page-${digest(value.url)}`
    return {
      id,
      url: value.url,
      title: text(value.title, 200) || value.url,
      header: text(value.header, 500),
      footer: text(value.footer, 500),
      truncated: value.truncated,
      controls: controlsFrom(value, id),
    }
  }

  /**
   * Persist an observed page, its controls, and the preceding browser transition when one exists.
   * @param previous - Page observed before this Browser call.
   * @param operation - Browser tool name that produced the page.
   * @param arguments_ - Tool arguments, used only to identify a control index and never persisted verbatim.
   * @param page - Resulting observed page.
   * @param action - Browser-reported action outcome, absent for a plain state read.
   * @returns When every generated Markdown note has been atomically published.
   */
  async record(
    previous: PageRecord | undefined,
    operation: string,
    arguments_: unknown,
    page: PageRecord,
    action: BrowserToolValue['action'] = undefined,
  ): Promise<void> {
    await this.writePage(page)
    await Promise.all(page.controls.map(async control => this.writeControl(page, control)))
    if (previous === undefined || operation === 'browser_state') return

    const control = operation === 'browser_click' || operation === 'browser_type' || operation === 'browser_select_option'
      ? previous.controls.find(item => item.index === this.indexFromArguments(arguments_))
      : undefined
    const actionId = `action-${digest(`${previous.id}:${operation}:${control?.id ?? ''}:${page.id}`)}`
    const actionPath = this.actionPath(actionId)
    const sourcePath = this.pagePath(previous.id)
    const targetPath = this.pagePath(page.id)
    const actionNote = [
      '---',
      'type: website-action',
      `operation: ${yaml(operation.replace('browser_', ''))}`,
      ...action === undefined ? [] : [
        `success: ${action.success}`,
        `message: ${yaml(action.message)}`,
      ],
      `observed_at: ${yaml(new Date().toISOString())}`,
      '---',
      '',
      `# ${text(operation.replace('browser_', ''))}`,
      '',
      `From ${noteLink(sourcePath, previous.title)} to ${noteLink(targetPath, page.title)}.`,
      ...control === undefined ? [] : [`Control: ${noteLink(this.controlPath(control.id), control.label)}.`],
      '',
    ].join('\n')
    await this.write(actionPath, actionNote)
    await this.appendAction(sourcePath, noteLink(actionPath, text(operation.replace('browser_', ''))))
  }

  /**
   * Read the generated Markdown note for one observed page.
   * @param page - Page whose graph note should be read.
   * @returns Complete Markdown content, or an empty string when it is not yet materialized.
   */
  async read(page: PageRecord): Promise<string> {
    return this.storage.read(this.pagePath(page.id))
  }

  /**
   * Read complete persisted notes by the exact extensionless paths returned by search.
   * The whole batch fails rather than returning partial or truncated source evidence.
   * @param paths - One to 32 logical paths below `BH Website Knowledge/`.
   * @returns Complete Markdown notes in first-occurrence request order.
   */
  async readNotes(paths: readonly string[]): Promise<KnowledgeNote[]> {
    return this.storage.readNotes(paths)
  }

  /**
   * Render current Browser evidence before it has been approved for persistence.
   * @param page - Current Browser page evidence.
   * @returns Markdown for the current staged page state.
   */
  describe(page: PageRecord): string {
    return [
      '---',
      'type: staged-browser-evidence',
      `url: ${yaml(page.url)}`,
      `controls_complete: ${!page.truncated}`,
      '---',
      '',
      `# ${page.title}`,
      '',
      '## Browser location',
      '',
      `- ${page.header || 'Current viewport'}`,
      `- ${page.footer || 'No footer state reported'}`,
      '',
      '## Controls',
      '',
      ...page.controls.length === 0 ? ['- No interactive controls were observed in this viewport.'] : page.controls.map(control =>
        `- ${control.label} — ${control.tag}, viewport index ${control.index}, tree depth ${control.depth}.`),
      '',
    ].join('\n')
  }

  /**
   * Search Markdown notes below the vault-owned knowledge root.
   * @param query - Focused feature, control, or test-case terms.
   * @returns At most eight ranked note excerpts.
   */
  async search(query: string): Promise<KnowledgeSearchResult[]> {
    return this.storage.search(query)
  }

  /**
   * Validate an approved proposal before any staged Browser evidence is committed.
   * @param title - Short proposal title.
   * @param content - Approved test knowledge or coverage decision.
   * @param evidence - User context and source-note or live-browser references.
   */
  validateApproved(title: string, content: string, evidence: string): void {
    if (text(title, 180).length === 0 || content.trim().length === 0 || evidence.trim().length === 0) {
      throw new Error('approved knowledge requires a title, content, and evidence')
    }
  }

  /**
   * Persist a user-approved proposal without presenting it as browser evidence.
   * @param title - Short proposal title.
   * @param content - Approved test knowledge or coverage decision.
   * @param evidence - User context and source-note or live-browser references.
   * @returns Logical note path beneath the vault-owned graph root.
   */
  async saveApproved(title: string, content: string, evidence: string): Promise<string> {
    this.validateApproved(title, content, evidence)
    const cleanTitle = text(title, 180)
    const cleanContent = content.trim()
    const cleanEvidence = evidence.trim()
    const id = `approved-${digest(`${cleanTitle}\n${cleanContent}\n${cleanEvidence}`)}`
    const path = `${GRAPH_ROOT}/Approved Knowledge/${id}`
    await this.write(path, [
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

  private indexFromArguments(arguments_: unknown): number | undefined {
    if (arguments_ === null || typeof arguments_ !== 'object') return undefined
    const index = (arguments_ as Record<string, unknown>).index
    return Number.isSafeInteger(index) && (index as number) >= 0 ? index as number : undefined
  }

  private async writePage(page: PageRecord): Promise<void> {
    const path = this.pagePath(page.id)
    await this.storage.update(path, (current) => {
      const actions = extractActionLines(current)
      return [
        '---',
        'type: website-page',
        `url: ${yaml(page.url)}`,
        `domain: ${yaml(this.settings.targetDomain)}`,
        `observed_at: ${yaml(new Date().toISOString())}`,
        `controls_complete: ${!page.truncated}`,
        '---',
        '',
        `# ${page.title}`,
        '',
        '## Browser location',
        '',
        `- ${page.header || 'Current viewport'}`,
        `- ${page.footer || 'No footer state reported'}`,
        '',
        '## Controls',
        '',
        ...page.controls.length === 0 ? ['- No interactive controls were observed in this viewport.'] : page.controls.map(control =>
          `- ${noteLink(this.controlPath(control.id), control.label)} — ${control.tag}, viewport index ${control.index}, tree depth ${control.depth}.`),
        '',
        '## Observed actions',
        '',
        ACTIONS_START,
        ...actions,
        ACTIONS_END,
        '',
      ].join('\n')
    })
  }

  private async writeControl(page: PageRecord, control: ControlRecord): Promise<void> {
    const path = this.controlPath(control.id)
    const content = [
      '---',
      'type: website-control',
      `page_url: ${yaml(page.url)}`,
      `tag: ${yaml(control.tag)}`,
      `viewport_index: ${control.index}`,
      `tree_depth: ${control.depth}`,
      `observed_at: ${yaml(new Date().toISOString())}`,
      '---',
      '',
      `# ${control.label}`,
      '',
      `Located on ${noteLink(this.pagePath(page.id), page.title)} at visible tree depth ${control.depth}.`,
      '',
      `Observed DOM: \`${control.descriptor.replace(/`/g, '\\`')}\``,
      '',
    ].join('\n')
    await this.storage.write(path, content)
  }

  private async appendAction(pagePath: string, actionLink: string): Promise<void> {
    await this.storage.update(pagePath, (current) => {
      if (current.includes(actionLink)) return current
      return current.replace(ACTIONS_END, `- ${actionLink}\n${ACTIONS_END}`)
    })
  }

  private async write(path: string, content: string): Promise<void> {
    await this.storage.write(path, content)
  }

  private pagePath(id: string): string {
    return `${this.logicalRoot}/pages/${id}`
  }

  private controlPath(id: string): string {
    return `${this.logicalRoot}/controls/${id}`
  }

  private actionPath(id: string): string {
    return `${this.logicalRoot}/actions/${id}`
  }
}
