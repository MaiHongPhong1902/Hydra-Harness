/** Recall bounds, authored wikilinks, and local vault read failures. */
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  assertKnowledgeNoteBytes, createLocalObsidianKnowledgeGraph, GRAPH_ROOT, MAX_READ_BYTES,
  ObsidianKnowledgeGraph, relatedKnowledgeNotes, searchTerms, validateKnowledgeNotePaths,
} from '../src/graph.ts'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function vault() {
  const root = await fs.mkdtemp(join(tmpdir(), 'hydra-graph-'))
  roots.push(root)
  await fs.mkdir(join(root, GRAPH_ROOT))
  return { root, graph: createLocalObsidianKnowledgeGraph({ vaultPath: root }) }
}

it.each(['', 'a', 'x'.repeat(161), '! @ #'])('rejects an unsearchable query %j', (query) => {
  expect(() => searchTerms(query)).toThrow('Obsidian knowledge query')
})

it('requires a bounded batch and counts complete UTF-8 note bytes', () => {
  for (const paths of [[], Array.from({ length: 33 }, (_, index) => `${GRAPH_ROOT}/${index}`)]) {
    expect(() => validateKnowledgeNotePaths(paths)).toThrow('requires 1 to 32 paths')
  }
  expect(() => { assertKnowledgeNoteBytes([{ path: `${GRAPH_ROOT}/large`, markdown: '界'.repeat(MAX_READ_BYTES / 3 + 1) }]) })
    .toThrow('split the batch')
  expect(() => createLocalObsidianKnowledgeGraph({ vaultPath: '.' })).toThrow('absolute non-root')
  expect(() => createLocalObsidianKnowledgeGraph({ vaultPath: parse(tmpdir()).root })).toThrow('absolute non-root')
})

it('resolves relative and sibling links, ignores anchors and escapes, and caps distinct neighbors', () => {
  const path = `${GRAPH_ROOT}/folder/source`
  const related = relatedKnowledgeNotes([{ path, markdown:
    '[[#heading]] [[/absolute]] [[./sibling.md#heading|Sibling]] [[../parent]] [[plain]] [[subdir/note]] '
    + '[[../../escape]] [[source]] [[./sibling]] [[Hydra Website Knowledge/Hydra MCP Vault Identity]]',
  }])
  expect(related.map(note => [note.path, note.title])).toEqual([
    [`${GRAPH_ROOT}/folder/sibling`, 'Sibling'], [`${GRAPH_ROOT}/parent`, 'parent'],
    [`${GRAPH_ROOT}/folder/plain`, 'plain'], [`${GRAPH_ROOT}/folder/subdir/note`, 'note'],
  ])
  expect(relatedKnowledgeNotes([{ path, markdown: Array.from({ length: 40 }, (_, index) => `[[note-${index}]]`).join(' ') }]))
    .toHaveLength(32)
})

it('keeps excerpts for results beyond the complete seed batch and centers a distant match', async () => {
  const matches = Array.from({ length: 6 }, (_, index) => ({ path: `${GRAPH_ROOT}/${index}`, title: String(index), excerpt: 'search excerpt' }))
  const graph = new ObsidianKnowledgeGraph({
    search: async () => matches,
    readNotes: async paths => paths.map(path => ({ path, markdown: 'before '.repeat(80) + 'needle' + ' after'.repeat(80) })),
    write: async () => {},
  })
  const recall = await graph.recall('needle')
  expect(recall.matches[0]?.excerpt).toMatch(/^….*needle.*…$/)
  expect(recall.matches[3]?.excerpt).toBe('search excerpt')
  for (const values of [['', 'content', 'evidence'], ['title', '', 'evidence'], ['title', 'content', '']]) {
    expect(() => { graph.validateApproved(...values as [string, string, string]) }).toThrow('requires a title, content, and evidence')
  }
})

it('sorts equally ranked notes by path and falls back to filenames without Markdown headings', async () => {
  const { root, graph } = await vault()
  await fs.writeFile(join(root, GRAPH_ROOT, 'z.md'), 'needle')
  await fs.writeFile(join(root, GRAPH_ROOT, 'a.md'), 'needle')
  await fs.writeFile(join(root, GRAPH_ROOT, 'ignored.txt'), 'needle')
  expect((await graph.recall('needle')).matches.map(note => note.title)).toEqual(['a', 'z'])
})

it('rejects directories and oversized local note batches', async () => {
  const { root, graph } = await vault()
  await fs.mkdir(join(root, GRAPH_ROOT, 'directory.md'))
  await expect(graph.readNotes([`${GRAPH_ROOT}/directory`])).rejects.toThrow('not a file')
  await fs.writeFile(join(root, GRAPH_ROOT, 'large.md'), 'x'.repeat(MAX_READ_BYTES + 1))
  await expect(graph.readNotes([`${GRAPH_ROOT}/large`])).rejects.toThrow('split the batch')
})

it('tolerates a removed search directory or file, but propagates other filesystem failures', async () => {
  const { root, graph } = await vault()
  await fs.rm(join(root, GRAPH_ROOT), { recursive: true })
  expect(await graph.recall('needle')).toEqual({ matches: [], related: [] })
  await fs.mkdir(join(root, GRAPH_ROOT))
  await fs.writeFile(join(root, GRAPH_ROOT, 'note.md'), 'needle')
  const missing = Object.assign(new Error('removed'), { code: 'ENOENT' })
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  vi.spyOn(fs, 'readFile').mockRejectedValueOnce(missing)
  expect(await graph.recall('needle')).toEqual({ matches: [], related: [] })
  vi.spyOn(fs, 'readFile').mockRejectedValueOnce(denied)
  await expect(graph.recall('needle')).rejects.toBe(denied)
  vi.spyOn(fs, 'readdir').mockRejectedValueOnce(denied)
  await expect(graph.recall('needle')).rejects.toBe(denied)
  vi.spyOn(fs, 'realpath').mockResolvedValueOnce(await fs.realpath(join(root, GRAPH_ROOT))).mockRejectedValueOnce(denied)
  await expect(graph.readNotes([`${GRAPH_ROOT}/note`])).rejects.toBe(denied)
})

it('limits a local search to five thousand Markdown files', async () => {
  const { root, graph } = await vault()
  for (let index = 0; index < 5001; index += 1) await fs.writeFile(join(root, GRAPH_ROOT, `${index}.md`), '')
  const read = vi.spyOn(fs, 'readFile')
  expect(await graph.recall('needle')).toEqual({ matches: [], related: [] })
  expect(read).toHaveBeenCalledTimes(5000)
}, 30_000)
