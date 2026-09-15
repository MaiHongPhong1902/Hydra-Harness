import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PageMemoryStore, pageKey, parseWorkflow, type PageKeyContext } from '../src/store.ts'

const directories: string[] = []

afterEach(async () => {
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

describe('pageKey', () => {
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
})
