/** Bounded, scoped page workflows backed by one owned SQLite database. */

import { lstat, mkdir, open as openFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { resolve, join } from 'node:path'
import { z } from 'zod'

const FORMAT_VERSION = 1
const APPLICATION_ID = 0x48594d31
const DATABASE_NAME = 'page-memory.sqlite'
const SQLITE_BUSY_TIMEOUT_MS = 5_000
const MAX_URL_BYTES = 16 * 1024
const MAX_CONTEXT_BYTES = 8 * 1024
const MAX_KEY_BYTES = 16 * 1024
const MAX_WORKFLOW_BYTES = 16 * 1024
const MAX_TASK_CHARS = 128
const MAX_SUMMARY_CHARS = 4_000
const MAX_TARGET_CHARS = 1_024
const MAX_TEXT_CHARS = 4_000
const MAX_LOCATOR_KEY_CHARS = 128
const MAX_LOCATORS = 64
const MAX_ANCHORS = 32
const MAX_STEPS = 64
const MAX_PITFALLS = 64
const SECRET_PARAMETER_WORDS = 'token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|secret|password|passwd|passcode|authorization|auth|credential|credentials|session(?:[_-]?id)?|client[_-]?secret|private[_-]?key|signature|sig|hmac|bearer|cookie'
const SECRET_ASSIGNMENT_RE = new RegExp(
  `(?:^|\\b)(?:${SECRET_PARAMETER_WORDS})\\b\\s*[:=]\\s*\\S+`,
  'iu',
)
const SECRET_PARAMETER_RE = new RegExp(`^(?:${SECRET_PARAMETER_WORDS}|code)$`, 'u')
const BEARER_SECRET_RE = /\bbearer\s+\S+/iu

/** A known route pattern. Dynamic path segments must use an explicit `:name`. */
export interface RouteRule {
  /** HTTP(S) origin whose pathname uses this route pattern. */
  readonly origin: string
  /** Absolute pathname with complete `:name` segments for dynamic values. */
  readonly path: string
}

/** Namespace separating page memory by workspace, application role, and locale. */
export interface PageKeyContext {
  /** Canonical workspace path that owns the memory namespace. */
  readonly workspace: string
  /** Host-configured role label for this memory namespace. */
  readonly role: string
  /** Host-configured locale label for this memory namespace. */
  readonly locale: string
}

const nonblank = (max: number, label: string) => z.string()
  .min(1, `${label} must not be empty`)
  .max(max, `${label} is too long`)
  .refine(value => value.trim().length > 0, `${label} must not be blank`)

const AnchorSchema = z.object({
  target: nonblank(MAX_TARGET_CHARS, 'anchor target'),
  text: nonblank(MAX_TEXT_CHARS, 'anchor text'),
}).strict()

const LocatorSchema = z.record(
  z.string().min(1).max(MAX_LOCATOR_KEY_CHARS),
  nonblank(MAX_TARGET_CHARS, 'locator'),
).refine(value => Object.keys(value).length <= MAX_LOCATORS, 'too many locators')

const WorkflowInputSchema = z.object({
  task: nonblank(MAX_TASK_CHARS, 'task'),
  summary: nonblank(MAX_SUMMARY_CHARS, 'summary'),
  accountHint: nonblank(MAX_TEXT_CHARS, 'account hint').optional(),
  anchors: z.array(AnchorSchema).min(1).max(MAX_ANCHORS),
  locators: LocatorSchema,
  steps: z.array(nonblank(MAX_TEXT_CHARS, 'step')).min(1).max(MAX_STEPS),
  successCheck: z.object({
    target: nonblank(MAX_TARGET_CHARS, 'success check target'),
    text: nonblank(MAX_TEXT_CHARS, 'success check text'),
  }).strict(),
  pitfalls: z.array(nonblank(MAX_TEXT_CHARS, 'pitfall')).max(MAX_PITFALLS),
}).strict()

/** A workflow accepted before a verified write. */
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>

const StoredWorkflowSchema = WorkflowInputSchema.extend({
  lastVerifiedAt: z.string().refine(isCanonicalTimestamp, 'invalid verification timestamp'),
  status: z.enum(['verified', 'stale']),
}).strict()

/** A workflow persisted by {@link PageMemoryStore}. */
export type StoredWorkflow = z.infer<typeof StoredWorkflowSchema>

interface PageRow {
  readonly page_key: string
}

interface WorkflowRow {
  readonly task: string
  readonly payload: string
}

interface CountRow {
  readonly count: number
  readonly bytes: number
}

interface PageCountRow {
  readonly count: number
}

/** Limits enforced by one page-memory database. */
export interface PageMemoryStoreLimits {
  /** Maximum complete serialized page record size in bytes. */
  readonly maxRecordBytes: number
  /** Maximum number of workflows retained for one page. */
  readonly maxWorkflows: number
  /** Maximum number of page keys retained in the database. */
  readonly maxPages: number
}

/** Parse and validate one untrusted workflow before any browser work.
 * @param input - Untrusted tool arguments.
 * @returns A normalized workflow ready for verification.
 */
export function parseWorkflow(input: unknown): WorkflowInput {
  const parsed = WorkflowInputSchema.parse(input)
  assertSafeWorkflow(parsed)
  const normalized: WorkflowInput = {
    ...parsed,
    anchors: parsed.anchors.map(anchor => ({ ...anchor })),
    locators: Object.fromEntries(Object.entries(parsed.locators).sort(([a], [b]) => a.localeCompare(b))),
    steps: [...parsed.steps],
    successCheck: { ...parsed.successCheck },
    pitfalls: [...parsed.pitfalls],
  }
  if (utf8Bytes(JSON.stringify(normalized)) > MAX_WORKFLOW_BYTES) {
    throw new Error(`page-memory: workflow exceeds ${MAX_WORKFLOW_BYTES} bytes`)
  }
  return normalized
}

/** Build a canonical key while preserving the complete query and fragment.
 * @param url - Current HTTP(S) page URL.
 * @param context - Host-owned workspace, role, and locale namespace.
 * @param routes - Explicit route patterns, in matching priority order.
 * @returns The canonical page key.
 */
export function pageKey(url: string, context: PageKeyContext, routes: readonly RouteRule[]): string {
  if (typeof url !== 'string' || utf8Bytes(url) > MAX_URL_BYTES) {
    throw new Error(`page-memory: URL exceeds ${MAX_URL_BYTES} bytes`)
  }
  if (url.length === 0 || /[\u0000-\u001f\u007f]/u.test(url)) {
    throw new Error('page-memory: URL is invalid')
  }
  const parsedContext = parseContext(context)
  const parsed = parseHttpUrl(url)
  const normalizedRoutes = normalizeRoutes(routes)
  const matched = normalizedRoutes.find(route => route.origin === parsed.origin && matchesPath(parsed.pathname, route.segments))
  const hashIndex = url.indexOf('#')
  const beforeHash = hashIndex < 0 ? url : url.slice(0, hashIndex)
  const queryIndex = beforeHash.indexOf('?')
  const exactQuery = queryIndex < 0 ? '' : beforeHash.slice(queryIndex)
  const exactHash = hashIndex < 0 ? '' : url.slice(hashIndex)
  const key = JSON.stringify({
    namespace: parsedContext,
    origin: parsed.origin,
    route: matched?.path ?? parsed.pathname,
    query: exactQuery,
    hash: exactHash,
  })
  if (utf8Bytes(key) > MAX_KEY_BYTES) throw new Error(`page-memory: page key exceeds ${MAX_KEY_BYTES} bytes`)
  return key
}

/** SQLite-backed page workflows with bounded records and transactional updates. */
export class PageMemoryStore {
  private readonly directory: string
  private readonly databasePath: string
  private readonly limits: PageMemoryStoreLimits
  private readonly ready: Promise<DatabaseSync>
  private closed = false
  private closing: Promise<void> | undefined

  /**
   * @param directory - Private directory owning this scoped page-memory database.
   * @param limits - Complete-record, per-page, and page-count limits.
   */
  constructor(directory: string, limits: PageMemoryStoreLimits) {
    if (typeof directory !== 'string' || directory.trim().length === 0) {
      throw new Error('page-memory: directory must not be blank')
    }
    validateLimits(limits)
    this.directory = resolve(directory)
    this.databasePath = join(this.directory, DATABASE_NAME)
    this.limits = { ...limits }
    this.ready = openDatabase(this.directory, this.databasePath)
    this.ready.catch(() => {})
  }

  /** Resolve after the database has been created and its owned schema checked.
   * @returns Completion after schema validation.
   */
  async open(): Promise<void> {
    await this.ready
  }

  /** Read every validated workflow for one exact page key.
   * @param key - Exact page key.
   * @returns Stored workflows for the page, or an empty array when absent.
   */
  async read(key: string): Promise<StoredWorkflow[]> {
    assertPageKey(key)
    const db = await this.database()
    this.begin(db, 'read')
    try {
      const workflows = this.readWithinTransaction(db, key) ?? []
      db.exec('COMMIT')
      return workflows
    } catch (error) {
      rollback(db)
      throw error
    }
  }

  /** Insert or replace one exact task and return its verified durable value.
   * @param key - Exact page key.
   * @param input - Untrusted workflow input.
   * @returns The persisted verified workflow.
   */
  async upsert(key: string, input: unknown): Promise<StoredWorkflow> {
    assertPageKey(key)
    const workflow = parseWorkflow(input)
    const db = await this.database()
    this.begin(db, 'write')
    try {
      const current = this.readWithinTransaction(db, key)
      const workflows = current ?? []
      if (current === undefined) {
        const pages = db.prepare('SELECT COUNT(*) AS count FROM pages').get() as unknown as PageCountRow
        if (pages.count >= this.limits.maxPages) {
          throw new Error(`page-memory: maxPages (${this.limits.maxPages}) exceeded`)
        }
        db.prepare('INSERT INTO pages (page_key) VALUES (?)').run(key)
      }
      const index = workflows.findIndex(candidate => candidate.task === workflow.task)
      if (index < 0 && workflows.length >= this.limits.maxWorkflows) {
        throw new Error(`page-memory: maxWorkflows (${this.limits.maxWorkflows}) exceeded`)
      }
      const stored: StoredWorkflow = {
        ...workflow,
        lastVerifiedAt: new Date().toISOString(),
        status: 'verified',
      }
      const payload = JSON.stringify(stored)
      const nextWorkflows = index < 0
        ? [...workflows, stored]
        : workflows.map((candidate, candidateIndex) => candidateIndex === index ? stored : candidate)
      this.assertRecordBytes(key, nextWorkflows)
      db.prepare(`
        INSERT INTO workflows (page_key, task, payload) VALUES (?, ?, ?)
        ON CONFLICT(page_key, task) DO UPDATE SET payload = excluded.payload
      `).run(key, workflow.task, payload)
      db.exec('COMMIT')
      return stored
    } catch (error) {
      rollback(db)
      throw error
    }
  }

  /** Mark one exact task stale while retaining its last verified timestamp.
   * @param key - Exact page key.
   * @param task - Exact task name.
   * @returns Completion after the update.
   */
  async markStale(key: string, task: string): Promise<void> {
    assertPageKey(key)
    if (typeof task !== 'string' || task.trim().length === 0) throw new Error('page-memory: task must not be blank')
    const db = await this.database()
    this.begin(db, 'write')
    try {
      const workflows = this.readWithinTransaction(db, key)
      if (workflows === undefined) {
        db.exec('COMMIT')
        return
      }
      const index = workflows.findIndex(candidate => candidate.task === task)
      if (index < 0) {
        db.exec('COMMIT')
        return
      }
      const workflow = workflows[index]
      if (workflow === undefined) {
        db.exec('COMMIT')
        return
      }
      if (workflow.status === 'stale') {
        db.exec('COMMIT')
        return
      }
      const stale: StoredWorkflow = { ...workflow, status: 'stale' }
      const payload = JSON.stringify(stale)
      this.assertRecordBytes(key, workflows.map((candidate, candidateIndex) => candidateIndex === index ? stale : candidate))
      db.prepare('UPDATE workflows SET payload = ? WHERE page_key = ? AND task = ?').run(payload, key, task)
      db.exec('COMMIT')
    } catch (error) {
      rollback(db)
      throw error
    }
  }

  /** Close the SQLite handle; repeated calls share one completion.
   * @returns Completion after the handle is closed.
   */
  close(): Promise<void> {
    this.closing ??= this.ready.then((db) => {
      if (!this.closed) {
        this.closed = true
        db.close()
      }
    }, () => {})
    return this.closing
  }

  private async database(): Promise<DatabaseSync> {
    const db = await this.ready
    if (this.closed) throw new Error('page-memory: store is closed')
    return db
  }

  private begin(db: DatabaseSync, kind: 'read' | 'write'): void {
    try {
      db.exec(kind === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN')
    } catch (error) {
      throw new Error(`page-memory: SQLite ${kind} transaction failed`, { cause: error })
    }
  }

  private assertStoredBounds(key: string, count: number, payloadBytes: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.limits.maxWorkflows
      || !Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
      throw new Error(`page-memory: stored workflow count exceeds maxWorkflows (${this.limits.maxWorkflows})`)
    }
    const emptyRecordBytes = utf8Bytes(JSON.stringify({ version: FORMAT_VERSION, key, workflows: [] }))
    const completeBytes = emptyRecordBytes + payloadBytes + Math.max(0, count - 1)
    if (completeBytes > this.limits.maxRecordBytes) {
      throw new Error(`page-memory: record exceeds maxRecordBytes (${this.limits.maxRecordBytes})`)
    }
  }

  private assertRecordBytes(key: string, workflows: readonly StoredWorkflow[]): void {
    if (workflows.length > this.limits.maxWorkflows) {
      throw new Error(`page-memory: stored workflow count exceeds maxWorkflows (${this.limits.maxWorkflows})`)
    }
    const rendered = JSON.stringify({ version: FORMAT_VERSION, key, workflows })
    if (utf8Bytes(rendered) > this.limits.maxRecordBytes) {
      throw new Error(`page-memory: record exceeds maxRecordBytes (${this.limits.maxRecordBytes})`)
    }
  }

  private readWithinTransaction(db: DatabaseSync, key: string): StoredWorkflow[] | undefined {
    const page = db.prepare('SELECT page_key FROM pages WHERE page_key = ?').get(key) as PageRow | undefined
    if (page === undefined) return undefined
    const count = db.prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes FROM workflows WHERE page_key = ?',
    ).get(key) as unknown as CountRow
    this.assertStoredBounds(key, count.count, count.bytes)
    const rows = db.prepare(
      'SELECT task, payload FROM workflows WHERE page_key = ? ORDER BY task',
    ).all(key) as unknown as WorkflowRow[]
    const workflows = rows.map(row => decodeWorkflowRow(row))
    assertUniqueTasks(workflows)
    return workflows
  }
}

async function openDatabase(directory: string, databasePath: string): Promise<DatabaseSync> {
  await ensurePrivateDirectory(directory)
  await ensureDatabaseFile(databasePath)
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA trusted_schema = OFF')
    db.exec('PRAGMA mmap_size = 0')
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    initializeOrValidateSchema(db, databasePath)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    const existing = await lstat(directory)
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`page-memory: directory is not a private directory: ${directory}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const created = await lstat(directory)
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`page-memory: directory is not a directory: ${directory}`)
  }
}

async function ensureDatabaseFile(path: string): Promise<void> {
  try {
    const existing = await lstat(path)
    assertRegularDatabaseFile(existing, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      const handle = await openFile(path, 'wx', 0o600)
      await handle.close()
    } catch (createError) {
      if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError
      const created = await lstat(path)
      assertRegularDatabaseFile(created, path)
    }
  }
}

function assertRegularDatabaseFile(stat: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`page-memory: database path is not a regular file: ${path}`)
}

function initializeOrValidateSchema(db: DatabaseSync, path: string): void {
  let began = false
  try {
    // Lock before reading metadata so concurrent first opens cannot both observe
    // an empty database and race to create the owned tables.
    db.exec('BEGIN IMMEDIATE')
    began = true
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
    const objectCount = (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { count: number }).count
    if (version === 0) {
      if (applicationId !== 0 || objectCount !== 0) throw new Error(`page-memory: unversioned database at "${path}" is not empty`)
      db.exec(`
        CREATE TABLE pages (
          page_key TEXT PRIMARY KEY
        ) STRICT;
        CREATE TABLE workflows (
          page_key TEXT NOT NULL REFERENCES pages(page_key) ON DELETE CASCADE,
          task TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (page_key, task)
        ) STRICT;
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${FORMAT_VERSION};
      `)
    }
    else if (version !== FORMAT_VERSION) {
      throw new Error(`page-memory: database schema version ${version} is incompatible with ${FORMAT_VERSION}`)
    } else if (applicationId !== APPLICATION_ID) {
      throw new Error(`page-memory: database application id ${applicationId} is not owned by page memory`)
    }
    validateSchema(db, path)
    db.exec('COMMIT')
    began = false
  } catch (error) {
    if (began) rollback(db)
    throw error
  }
}

function validateSchema(db: DatabaseSync, path: string): void {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as unknown as Array<{ name: string }>
  if (rows.map(row => row.name).join(',') !== 'pages,workflows') {
    throw new Error(`page-memory: database at "${path}" has an unsupported schema`)
  }
  const pages = db.prepare('PRAGMA table_info(pages)').all() as unknown as Array<{ name: string; type: string }>
  const workflows = db.prepare('PRAGMA table_info(workflows)').all() as unknown as Array<{ name: string; type: string }>
  if (pages.map(row => `${row.name}:${row.type}`).join(',') !== 'page_key:TEXT'
    || workflows.map(row => `${row.name}:${row.type}`).join(',') !== 'page_key:TEXT,task:TEXT,payload:TEXT') {
    throw new Error(`page-memory: database at "${path}" has a corrupt schema`)
  }
}

function decodeWorkflowRow(row: WorkflowRow): StoredWorkflow {
  if (typeof row.task !== 'string' || typeof row.payload !== 'string') throw new Error('page-memory: corrupt workflow row')
  let value: unknown
  try {
    value = JSON.parse(row.payload)
  } catch (error) {
    throw new Error('page-memory: corrupt workflow JSON', { cause: error })
  }
  const parsed = StoredWorkflowSchema.parse(value)
  assertSafeWorkflow(parsed)
  if (parsed.task !== row.task) throw new Error('page-memory: workflow task index does not match payload')
  return parsed
}

function assertUniqueTasks(workflows: readonly StoredWorkflow[]): void {
  const tasks = new Set<string>()
  for (const workflow of workflows) {
    if (tasks.has(workflow.task)) throw new Error(`page-memory: duplicate workflow task "${workflow.task}"`)
    tasks.add(workflow.task)
  }
}

function assertSafeWorkflow(workflow: WorkflowInput | StoredWorkflow): void {
  const strings: Array<[string, string]> = [
    ['task', workflow.task],
    ['summary', workflow.summary],
    ...workflow.anchors.flatMap((anchor, index) => [[`anchors[${index}].target`, anchor.target], [`anchors[${index}].text`, anchor.text]] as Array<[string, string]>),
    ...Object.entries(workflow.locators).map(([name, value]) => [`locators.${name}`, value] as [string, string]),
    ...workflow.steps.map((step, index) => [`steps[${index}]`, step] as [string, string]),
    ['successCheck.target', workflow.successCheck.target],
    ['successCheck.text', workflow.successCheck.text],
    ...workflow.pitfalls.map((pitfall, index) => [`pitfalls[${index}]`, pitfall] as [string, string]),
  ]
  if (workflow.accountHint !== undefined) strings.push(['accountHint', workflow.accountHint])
  for (const [field, value] of strings) assertSafeText(field, value)
}

function assertSafeText(field: string, value: string): void {
  if (/^\s*(?:javascript|data|vbscript):/iu.test(value)) {
    throw new Error(`page-memory: ${field} contains an executable URL`)
  }
  if ((field.endsWith('.target') || field.startsWith('locators.'))
    && /(?:\bgetBy(?:Role|Label|TestId|Text)\s*\(|\blocator\s*\(|\bxpath\s*=|\bxpath:\/\/)/iu.test(value)) {
    throw new Error(`page-memory: ${field} must be a CSS selector, not executable locator syntax`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`page-memory: ${field} contains control characters`)
  if (/(?:^|\W)e\d+(?=$|\W)/iu.test(value)
    || /\b(?:ref|aria-ref)\s*=\s*\w*\d+\b/iu.test(value)
    || /\bdata-hydra-a11y-ref\b/iu.test(value)
    || /\b(?:index|idx|element[ _-]?index|ordinal|position)\s*[:=]\s*\d+\b/iu.test(value)
    || /\b(?:nth|nth-child|nth-of-type)\s*\(\s*\d+\s*\)/iu.test(value)
    || /(?:^|[^\w])\[\s*\d+\s*\]/u.test(value)) {
    throw new Error(`page-memory: ${field} contains a transient browser reference`)
  }
  if (SECRET_ASSIGNMENT_RE.test(value)
    || BEARER_SECRET_RE.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/u.test(value)
    || /\b(?:sk|rk|pk)-\w{16,}\b/iu.test(value)
    || /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(value)) {
    throw new Error(`page-memory: ${field} contains an obvious secret`)
  }
}

function parseContext(context: PageKeyContext): PageKeyContext {
  const parsed = z.object({
    workspace: nonblank(2_048, 'workspace'),
    role: nonblank(512, 'role'),
    locale: nonblank(128, 'locale'),
  }).strict().parse(context)
  if (utf8Bytes(JSON.stringify(parsed)) > MAX_CONTEXT_BYTES) throw new Error(`page-memory: context exceeds ${MAX_CONTEXT_BYTES} bytes`)
  return parsed
}

function parseHttpUrl(value: string): { origin: string; pathname: string } {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error('page-memory: URL is invalid', { cause: error })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('page-memory: URL must use HTTP(S)')
  if (parsed.username.length > 0 || parsed.password.length > 0) throw new Error('page-memory: URL credentials are not allowed')
  assertNoSecretParameters(parsed.search, parsed.hash)
  return { origin: parsed.origin, pathname: parsed.pathname }
}

function assertNoSecretParameters(search: string, hash: string): void {
  for (const raw of [search.slice(1), hash.slice(1)]) {
    for (const part of raw.split(/[&?;]/u)) {
      const encodedName = part.split('=', 1)[0] ?? ''
      let name: string
      try {
        name = decodeURIComponent(encodedName.replaceAll('+', ' ')).trim().toLowerCase()
      } catch (error) {
        throw new Error('page-memory: URL contains malformed query or fragment encoding', { cause: error })
      }
      if (SECRET_PARAMETER_RE.test(name)) {
        throw new Error(`page-memory: URL contains a secret parameter named "${name}"`)
      }
    }
  }
}

function normalizeRoutes(routes: readonly RouteRule[]): Array<{ origin: string; path: string; segments: string[] }> {
  if (!Array.isArray(routes)) throw new Error('page-memory: routes must be an array')
  const seen = new Set<string>()
  const candidates: readonly unknown[] = routes
  return candidates.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new Error('page-memory: route must be an object')
    }
    const route = candidate as RouteRule
    const origin = normalizeOrigin(route.origin)
    const segments = routeSegments(route.path)
    const structural = `${origin}\u0000${segments.map(segment => segment.startsWith(':') ? ':' : segment).join('/')}`
    if (seen.has(structural)) throw new Error(`page-memory: duplicate or ambiguous route pattern "${route.path}"`)
    seen.add(structural)
    return { origin, path: route.path, segments }
  })
}

function normalizeOrigin(value: string): string {
  if (typeof value !== 'string') throw new Error('page-memory: route origin must be a string')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error('page-memory: route origin is invalid', { cause: error })
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username.length > 0 || parsed.password.length > 0
    || parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error('page-memory: route origin must be an HTTP(S) origin')
  }
  return parsed.origin
}

function routeSegments(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0 || !path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('\\')) {
    throw new Error('page-memory: route path must be an absolute path without query or fragment')
  }
  const segments = path.split('/')
  for (const segment of segments.slice(1)) {
    if (segment.startsWith(':')) {
      if (!/^:[A-Za-z][A-Za-z0-9_-]*$/u.test(segment)) throw new Error(`page-memory: invalid route parameter "${segment}"`)
    } else if (segment.includes(':')) {
      throw new Error(`page-memory: route parameter must occupy a complete segment: "${segment}"`)
    }
  }
  return segments
}

function matchesPath(pathname: string, segments: readonly string[]): boolean {
  const actual = pathname.split('/')
  return actual.length === segments.length && segments.every((segment, index) => segment.startsWith(':') || segment === actual[index])
}

function assertPageKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) throw new Error('page-memory: page key must not be empty')
  if (utf8Bytes(key) > MAX_KEY_BYTES) throw new Error(`page-memory: page key exceeds ${MAX_KEY_BYTES} bytes`)
}

function validateLimits(limits: PageMemoryStoreLimits): void {
  const candidate: unknown = limits
  if (candidate === null || typeof candidate !== 'object') throw new Error('page-memory: limits are required')
  for (const [name, value] of [
    ['maxRecordBytes', limits.maxRecordBytes],
    ['maxWorkflows', limits.maxWorkflows],
    ['maxPages', limits.maxPages],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`page-memory: ${name} must be a positive safe integer`)
    }
  }
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function rollback(db: DatabaseSync): void {
  try { db.exec('ROLLBACK') } catch { /* retain the operation failure */ }
}
