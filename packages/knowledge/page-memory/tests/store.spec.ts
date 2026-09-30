import { DatabaseSync } from 'node:sqlite'
import { lstat, mkdir, mkdtemp, open as openFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageMemoryStore, pageKey, parseWorkflow, type PageKeyContext } from '../src/store.ts'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, lstat: vi.fn(fs.lstat), open: vi.fn(fs.open) }
})

const directories: string[] = []
const stores: PageMemoryStore[] = []
const limits = { maxRecordBytes: 32_768, maxWorkflows: 12, maxPages: 500, maxHistory: 32 }

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hydra-page-memory-store-'))
  directories.push(directory)
  return directory
}

const context: PageKeyContext = {
  workspace: 'workspace-a',
  role: 'operator',
  locale: 'vi-VN',
}

const routes = [{ origin: 'https://shop.test', path: '/orders/:id' }]

function workflow(task: string, summary = 'Reusable procedure.'): Record<string, unknown> {
  return {
    task,
    summary,
    anchors: [{ target: '#orders', text: 'Orders' }],
    locators: { search: '#search' },
    steps: ['Fill the search field.', 'Check the result.'],
    successCheck: { target: '#status', text: 'Saved' },
    pitfalls: ['Read changing values from the live page.'],
  }
}

function key(url = 'https://shop.test/orders/123?tab=payments&sort=%2F#row%2F1'): string {
  return pageKey(url, context, routes)
}

async function seeded() {
  const directory = await scratch()
  const store = new PageMemoryStore(directory, limits)
  stores.push(store)
  const saved = await store.upsert(key(), workflow('save'))
  const edit = (sql: string) => {
    const db = new DatabaseSync(join(directory, 'page-memory.sqlite'))
    try { db.exec(sql) } finally { db.close() }
  }
  return { directory, store, saved, edit }
}

describe('pageKey', () => {
  it.each(['', '\u0001', 'not a URL', 'https://shop.test/?%=bad'])('rejects malformed URL %j', (url) => {
    expect(() => pageKey(url, context, [])).toThrow(/invalid|encoding/)
  })

  it('bounds serialized namespace and complete key bytes', () => {
    expect(() => pageKey('https://shop.test', { workspace: '\u0001'.repeat(2048), role: '界'.repeat(512), locale: '界'.repeat(128) }, []))
      .toThrow('context exceeds')
    expect(() => pageKey(`https://shop.test/?q=${'x'.repeat(16300)}`, context, [])).toThrow('page key exceeds')
    expect(pageKey('https://shop.test/other', context, [{ origin: 'https://other.test', path: '/other' }])).toContain('/other')
  })

  it.each(['invalid', 'ftp://shop.test', 'https://user@shop.test', 'https://shop.test/path',
    'https://shop.test/?query', 'https://shop.test/#fragment'])('rejects route origin %s', (origin) => {
    expect(() => pageKey('https://shop.test', context, [{ origin, path: '/' }])).toThrow('route origin')
  })

  it.each(['', 'relative', '/query?', '/hash#', '/back\\slash', '/:123', '/prefix:id'])('rejects route path %j', (path) => {
    expect(() => pageKey('https://shop.test', context, [{ origin: 'https://shop.test', path }])).toThrow('route')
  })

  it('uses explicit route parameters and keeps exact query and fragment text', () => {
    const parsed = JSON.parse(key()) as Record<string, unknown>
    expect(parsed).toEqual({
      namespace: context,
      origin: 'https://shop.test',
      route: '/orders/:id',
      query: '?tab=payments&sort=%2F',
      hash: '#row%2F1',
    })
    expect(pageKey('https://shop.test/orders/456?tab=payments&sort=%2F#row%2F1', context, routes)).toBe(key())
    expect(pageKey('https://shop.test/orders/456?tab=open#row%2F1', context, routes)).not.toBe(key())
    expect(pageKey('https://shop.test/orders/456?tab=payments&sort=%2F#row%2F2', context, routes)).not.toBe(key())
  })

  it('does not collapse numeric paths without an explicit route', () => {
    const noRoutes: never[] = []
    expect(pageKey('https://shop.test/orders/123', context, noRoutes)).not.toBe(
      pageKey('https://shop.test/orders/456', context, noRoutes),
    )
  })

  it('isolates workspaces, roles, and locales', () => {
    const url = 'https://shop.test/orders'
    const original = pageKey(url, context, [])
    for (const field of ['workspace', 'role', 'locale'] as const) {
      expect(pageKey(url, { ...context, [field]: `${context[field]}-other` }, [])).not.toBe(original)
    }
  })

  it('takes the first matching route and rejects duplicate structural patterns', () => {
    const selected = JSON.parse(pageKey('https://shop.test/orders/new', context, [
      { origin: 'https://shop.test', path: '/orders/:id' },
      { origin: 'https://shop.test', path: '/orders/new' },
    ])) as { route: string }
    expect(selected.route).toBe('/orders/:id')
    expect(() => pageKey('https://shop.test/orders/1', context, [
      { origin: 'https://shop.test', path: '/orders/:id' },
      { origin: 'https://shop.test', path: '/orders/:orderId' },
    ])).toThrow(/duplicate|ambiguous/i)
  })

  it('rejects unsafe, secret-bearing, and overlong URLs', () => {
    expect(() => pageKey('javascript:alert(1)', context, [])).toThrow(/HTTP\(S\)/i)
    expect(() => pageKey('https://user:password@shop.test/orders', context, [])).toThrow(/credentials/i)
    expect(() => pageKey('https://shop.test/orders?access_token=secret', context, [])).toThrow(/secret/i)
    expect(() => pageKey('https://shop.test/orders?code=1234', context, [])).toThrow(/secret/i)
    expect(() => pageKey('https://shop.test/orders#token=secret', context, [])).toThrow(/secret/i)
    expect(() => pageKey(`https://shop.test/orders?query=${'x'.repeat(16 * 1024)}`, context, [])).toThrow(/exceeds/i)
  })
})

describe('parseWorkflow', () => {
  it.each(['javascript:alert(1)', 'a\u0000b', 'bearer sensitive-value', 'AKIA1234567890123456',
    'eyJ1234567890123456.abcdefgh.abcdefgh', '-----BEGIN PRIVATE KEY-----', '[ 2 ]'])('rejects unsafe text %j', (summary) => {
    expect(() => parseWorkflow(workflow('save', summary))).toThrow()
  })

  it('bounds a complete workflow independently of each field', () => {
    expect(() => parseWorkflow({ ...workflow('save'), steps: Array.from({ length: 6 }, () => 'x'.repeat(3000)) }))
      .toThrow('workflow exceeds')
  })

  it('returns a strict normalized workflow and accepts stable CSS selectors', () => {
    const parsed = parseWorkflow({ ...workflow('save'), locators: { z: '.z', a: '.a' } })
    expect(parsed.locators).toEqual({ a: '.a', z: '.z' })
    expect(() => parseWorkflow({
      ...workflow('safe'),
      summary: 'Use the password field and inspect session details before saving. Expect HTTP status code: 200.',
      accountHint: 'Use a staff account with order-management access.',
    })).not.toThrow()
    expect(() => parseWorkflow({ ...workflow('save'), unexpected: true })).toThrow()
    expect(() => parseWorkflow({ ...workflow('save'), anchors: [] })).toThrow()
    expect(() => parseWorkflow({ ...workflow('save'), accountHint: ' ' })).toThrow()
    expect(() => parseWorkflow({ ...workflow('save'), accountHint: 'x'.repeat(4_001) })).toThrow()
  })

  it.each([
    ['e17', 'target'],
    ['[ref=e17]', 'target'],
    ['[data-hydra-a11y-ref="e17"]', 'target'],
    ['index: 2', 'target'],
    ['li:nth-child(2)', 'target'],
    ["getByRole('button', { name: 'Save' })", 'target'],
    ['xpath=//button[1]', 'target'],
    ['password=super-secret', 'summary'],
    ['sk-12345678901234567890', 'summary'],
    ['password=super-secret', 'accountHint'],
  ])('rejects transient refs, executable locators, or secrets in %s', (value, field) => {
    const input = { ...workflow('unsafe') } as Record<string, unknown>
    if (field === 'target') input.locators = { save: value }
    else input[field] = value
    expect(() => parseWorkflow(input)).toThrow()
  })
})

describe('PageMemoryStore', () => {
  it('rejects a directory replaced during creation and propagates database create errors', async () => {
    const directory = await scratch()
    const file = join(directory, 'file')
    await writeFile(file, '')
    const info = await lstat(file)
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' })).mockResolvedValueOnce(info)
    const raced = new PageMemoryStore(join(directory, 'nested'), limits)
    stores.push(raced)
    await expect(raced.open()).rejects.toThrow('not a directory')
    vi.mocked(openFile).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    const denied = new PageMemoryStore(directory, limits)
    stores.push(denied)
    await expect(denied.open()).rejects.toThrow('permission denied')
  })

  it('closes a database when its schema transaction cannot start', async () => {
    const directory = await scratch()
    // oxlint-disable-next-line typescript/unbound-method -- The spy retains the original database receiver with call().
    const execute = DatabaseSync.prototype.exec
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'BEGIN IMMEDIATE') throw new Error('database is busy')
      execute.call(this, sql)
    })
    const store = new PageMemoryStore(directory, limits)
    stores.push(store)
    await expect(store.open()).rejects.toThrow('database is busy')
  })

  it('rejects blank directories, invalid limits, keys and verification durations', async () => {
    expect(() => new PageMemoryStore(' ', limits)).toThrow('directory')
    expect(() => new PageMemoryStore('unused', { ...limits, maxHistory: 0 })).toThrow('maxHistory')
    const { store, saved } = await seeded()
    for (const invalid of ['', 'x'.repeat(16385)]) await expect(store.read(invalid)).rejects.toThrow('page key')
    for (const duration of [-1, NaN, Infinity]) {
      await expect(store.upsert(key(), workflow('save'), duration)).rejects.toThrow('duration')
      await expect(store.recordVerification(key(), saved, 'verified', duration)).rejects.toThrow('duration')
    }
    await expect(store.history(key(), '')).rejects.toThrow()
    expect(await store.recordVerification('missing', saved, 'verified', 0)).toBe(false)
    expect(await store.history(key())).toHaveLength(1)
    expect(store.close()).toBe(store.close())
    await store.close()
    await expect(store.read(key())).rejects.toThrow('closed')
  })

  it('creates nested directories and rejects file/directory collisions', async () => {
    const directory = await scratch()
    const nested = new PageMemoryStore(join(directory, 'nested'), limits)
    stores.push(nested)
    await nested.open()
    await writeFile(join(directory, 'file'), '')
    const file = new PageMemoryStore(join(directory, 'file'), limits)
    stores.push(file)
    await expect(file.open()).rejects.toThrow('private directory')
    await mkdir(join(directory, 'page-memory.sqlite'))
    const collision = new PageMemoryStore(directory, limits)
    stores.push(collision)
    await expect(collision.open()).rejects.toThrow('regular file')
  })

  it.each([
    ['PRAGMA user_version = 0; PRAGMA application_id = 1', 'not empty'],
    ['PRAGMA user_version = 0; PRAGMA application_id = 0', 'not empty'],
    ['PRAGMA application_id = 1', 'application id'],
    ['CREATE TABLE foreign_table (value TEXT)', 'unsupported schema'],
    ['ALTER TABLE pages ADD COLUMN extra TEXT', 'corrupt schema'],
    ['ALTER TABLE workflows ADD COLUMN extra TEXT', 'corrupt schema'],
    ['ALTER TABLE workflow_history ADD COLUMN extra TEXT', 'corrupt schema'],
  ])('fails closed on database metadata %s', async (sql, message) => {
    const { directory, store, edit } = await seeded()
    await store.close()
    edit(sql)
    const reader = new PageMemoryStore(directory, limits)
    stores.push(reader)
    await expect(reader.open()).rejects.toThrow(message)
  })

  it.each([
    ["UPDATE workflows SET payload = json_set(payload, '$.task', 'other')", 'task index'],
    ["UPDATE workflows SET payload = json_set(payload, '$.lastVerifiedAt', 'invalid')", 'timestamp'],
    ["UPDATE workflows SET payload = json_set(payload, '$.lastVerifiedAt', '2026-02-31T00:00:00.000Z')", 'timestamp'],
    ["UPDATE workflows SET payload = json_set(payload, '$.lastVerifiedAt', '2026-13-01T00:00:00.000Z')", 'timestamp'],
    ["UPDATE workflows SET payload = json_set(payload, '$.summary', 'password=secret')", 'secret'],
  ])('rejects corrupt persisted workflow data %s', async (sql, message) => {
    const { store, edit } = await seeded()
    edit(sql)
    await expect(store.read(key())).rejects.toThrow(message)
  })

  it('rejects exhausted revisions and oversized stored data without replacing evidence', async () => {
    const { store, edit } = await seeded()
    edit("UPDATE workflows SET payload = json_set(payload, '$.revision', 9007199254740991)")
    await expect(store.upsert(key(), workflow('save'))).rejects.toThrow('revision exhausted')
    edit("UPDATE workflows SET payload = '" + 'x'.repeat(33000) + "'")
    await expect(store.read(key())).rejects.toThrow('record exceeds')
  })

  it('enforces reduced read limits on existing workflows and history', async () => {
    const { directory, store } = await seeded()
    await store.upsert(key(), workflow('other'))
    await store.close()
    const narrow = new PageMemoryStore(directory, { ...limits, maxWorkflows: 1, maxHistory: 1 })
    stores.push(narrow)
    await expect(narrow.read(key())).rejects.toThrow('maxWorkflows')
    await expect(narrow.history(key())).rejects.toThrow('history exceeds')
  })

  it.each([
    ['UPDATE workflow_history SET id = -1', 'corrupt history'],
    ["UPDATE workflow_history SET recorded_at = 'invalid'", 'corrupt history'],
    ["PRAGMA ignore_check_constraints = ON; UPDATE workflow_history SET source = 'unknown'", 'corrupt history'],
    ["PRAGMA ignore_check_constraints = ON; UPDATE workflow_history SET outcome = 'unknown'", 'corrupt history'],
    ['PRAGMA ignore_check_constraints = ON; UPDATE workflow_history SET duration_ms = -1', 'duration'],
    ["UPDATE workflow_history SET outcome = 'stale'", 'invalid saved'],
    ["UPDATE workflow_history SET payload = json_set(payload, '$.status', 'stale')", 'invalid saved'],
  ])('rejects corrupt verification history %s', async (sql, message) => {
    const { store, edit } = await seeded()
    edit(sql)
    await expect(store.history(key())).rejects.toThrow(message)
  })

  it('rolls back failed verification writes and reports SQLite transaction failures', async () => {
    const { store, saved, edit } = await seeded()
    edit("CREATE TRIGGER reject_history BEFORE INSERT ON workflow_history BEGIN SELECT RAISE(ABORT, 'write failed'); END")
    await expect(store.recordVerification(key(), saved, 'stale', 1)).rejects.toThrow('write failed')
    expect((await store.read(key()))[0]?.status).toBe('verified')
    // oxlint-disable-next-line typescript/unbound-method -- The spy retains the original database receiver with call().
    const execute = DatabaseSync.prototype.exec
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'BEGIN') throw new Error('unavailable')
      execute.call(this, sql)
    })
    await expect(store.read(key())).rejects.toThrow('SQLite read transaction failed')
  })

  it('replaces by exact task, marks stale, and isolates page keys', async () => {
    const directory = await scratch()
    const store = new PageMemoryStore(directory, { maxRecordBytes: 32_768, maxWorkflows: 12, maxPages: 500, maxHistory: 32 })
    const first = key()
    const second = key('https://shop.test/orders/123?tab=open#list')
    await expect(store.read(first)).resolves.toEqual([])
    const saved = await store.upsert(first, { ...workflow('save', 'First version.'), accountHint: 'Use a staff account.' })
    expect(saved.status).toBe('verified')
    expect(saved.lastVerifiedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
    await store.upsert(first, workflow('find', 'Find version.'))
    await store.upsert(first, { ...workflow('save', 'Replacement.'), accountHint: 'Use an order-manager account.' })
    await expect(store.read(first)).resolves.toHaveLength(2)
    await expect(store.read(first)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ task: 'save', summary: 'Replacement.', status: 'verified', accountHint: 'Use an order-manager account.' }),
      expect.objectContaining({ task: 'find' }),
    ]))
    const inspected = (await store.read(first)).find(candidate => candidate.task === 'save')!
    await store.recordVerification(first, inspected, 'stale', 1)
    await expect(store.read(first)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ task: 'save', summary: 'Replacement.', status: 'stale' }),
    ]))
    await expect(store.read(second)).resolves.toEqual([])
    await store.close()
  })

  it('keeps concurrent task updates and enforces workflow/page bounds', async () => {
    const directory = await scratch()
    const store = new PageMemoryStore(directory, { maxRecordBytes: 32_768, maxWorkflows: 2, maxPages: 1, maxHistory: 32 })
    const first = key()
    await Promise.all([store.upsert(first, workflow('a')), store.upsert(first, workflow('b'))])
    await expect(store.read(first)).resolves.toHaveLength(2)
    await expect(store.upsert(first, workflow('c'))).rejects.toThrow(/maxWorkflows/)
    await expect(store.upsert(key('https://shop.test/orders/1?tab=other'), workflow('other'))).rejects.toThrow(/maxPages/)
    await store.close()
  })

  it('allows concurrent first opens of one database', async () => {
    const directory = await scratch()
    const limits = { maxRecordBytes: 32_768, maxWorkflows: 12, maxPages: 500, maxHistory: 32 }
    const first = new PageMemoryStore(directory, limits)
    const second = new PageMemoryStore(directory, limits)
    await expect(Promise.all([first.open(), second.open()])).resolves.toBeDefined()
    await first.upsert(key(), workflow('save'))
    await expect(second.read(key())).resolves.toEqual([expect.objectContaining({ task: 'save' })])
    await Promise.all([first.close(), second.close()])
  })

  it('rejects oversized records, malformed rows, unsupported schema, and database symlinks', async () => {
    const directory = await scratch()
    const store = new PageMemoryStore(directory, { maxRecordBytes: 512, maxWorkflows: 12, maxPages: 500, maxHistory: 32 })
    await expect(store.upsert(key(), workflow('large', 'x'.repeat(400)))).rejects.toThrow(/maxRecordBytes/)
    await store.close()

    const databasePath = join(directory, 'page-memory.sqlite')
    const corrupt = new DatabaseSync(databasePath)
    corrupt.prepare('INSERT INTO pages (page_key) VALUES (?)').run('corrupt')
    corrupt.prepare('INSERT INTO workflows (page_key, task, payload) VALUES (?, ?, ?)').run('corrupt', 'bad', '{not json')
    corrupt.close()
    const reader = new PageMemoryStore(directory, { maxRecordBytes: 32_768, maxWorkflows: 12, maxPages: 500, maxHistory: 32 })
    await expect(reader.read('corrupt')).rejects.toThrow(/corrupt|JSON/i)
    await reader.close()

    const versionDirectory = await scratch()
    const versionStore = new PageMemoryStore(versionDirectory, { maxRecordBytes: 32_768, maxWorkflows: 12, maxPages: 500, maxHistory: 32 })
    await versionStore.open()
    await versionStore.close()
    const versionDb = new DatabaseSync(join(versionDirectory, 'page-memory.sqlite'))
    versionDb.exec('PRAGMA user_version = 99')
    versionDb.close()
    const incompatible = new PageMemoryStore(versionDirectory, { maxRecordBytes: 32_768, maxWorkflows: 12, maxPages: 500, maxHistory: 32 })
    await expect(incompatible.open()).rejects.toThrow(/schema version/i)
    await incompatible.close()

    if (process.platform !== 'win32') {
      const target = await scratch()
      const link = join(target, 'page-memory.sqlite')
      await symlink(databasePath, link)
      const linkedStore = new PageMemoryStore(target, {
        maxRecordBytes: 32_768,
        maxWorkflows: 12,
        maxPages: 500,
        maxHistory: 32,
      })
      await expect(linkedStore.open()).rejects.toThrow(/regular file|symlink/i)
    }
  })

  it('creates owner-only database and directory modes on POSIX', async () => {
    if (process.platform === 'win32') return
    const directory = await scratch()
    const store = new PageMemoryStore(directory, { maxRecordBytes: 32_768, maxWorkflows: 12, maxPages: 500, maxHistory: 32 })
    await store.open()
    const { stat } = await import('node:fs/promises')
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(directory, 'page-memory.sqlite'))).mode & 0o777).toBe(0o600)
    await store.close()
  })

  it('retains bounded verification history and rejects an obsolete observation', async () => {
    const directory = await scratch()
    const store = new PageMemoryStore(directory, { maxRecordBytes: 32_768, maxWorkflows: 12, maxPages: 500, maxHistory: 2 })
    const page = key()
    const saved = await store.upsert(page, workflow('save'), 12.5)
    expect((await store.history(page, 'save'))).toEqual([expect.objectContaining({ source: 'save', outcome: 'verified', durationMs: 12.5 })])
    expect(await store.recordVerification(page, saved, 'verified', 3)).toBe(true)
    await store.upsert(page, { ...workflow('save'), summary: 'Replacement.' }, 4)
    expect(await store.recordVerification(page, saved, 'stale', 9)).toBe(false)
    const traces = await store.history(page, 'save')
    expect(traces).toHaveLength(2)
    expect(traces.at(-1)?.workflow.summary).toBe('Replacement.')
    expect(traces.every(trace => trace.durationMs !== null && trace.durationMs >= 0)).toBe(true)
    await store.close()
  })

  it('persists a bounded stale diagnostic and clears it on replacement', async () => {
    const { directory, store, saved } = await seeded()
    const reason = 'Expected text did not match at #orders.'
    expect(await store.recordVerification(key(), saved, 'stale', 1, reason)).toBe(true)
    const reopened = new PageMemoryStore(directory, limits)
    stores.push(reopened)
    expect(await reopened.read(key())).toEqual([expect.objectContaining({ status: 'stale', staleReason: reason })])
    const replacement = await reopened.upsert(key(), workflow('save'))
    expect(replacement.revision).toBe(saved.revision + 1)
    expect(replacement.staleReason).toBeUndefined()
  })

  it.each(['', 'x'.repeat(4097), 'unsafe\u0000reason', 'Authorization: Bearer secret'])('rejects unsafe or unbounded stale diagnostics: %s', async (reason) => {
    const { store, saved } = await seeded()
    await expect(store.recordVerification(key(), saved, 'stale', 1, reason)).rejects.toThrow()
    expect(await store.read(key())).toEqual([saved])
  })

  it('keeps the complete record byte limit when adding a stale diagnostic', async () => {
    const { directory, saved } = await seeded()
    const maxRecordBytes = Buffer.byteLength(JSON.stringify({ version: 3, key: key(), workflows: [saved] }))
    const bounded = new PageMemoryStore(directory, { ...limits, maxRecordBytes })
    stores.push(bounded)
    await expect(bounded.recordVerification(key(), saved, 'stale', 1, 'Expected text did not match at #orders.')).rejects.toThrow('maxRecordBytes')
    expect(await bounded.read(key())).toEqual([saved])
  })
})
