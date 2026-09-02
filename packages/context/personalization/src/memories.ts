/** Local, user-approved memory storage. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@bosch/bh-atomic-write'
import type { MemoryEntry } from './session.ts'

/** Stable file format version for the local memory document. */
const MEMORY_FILE_VERSION = 1
const MAX_MEMORY_ENTRIES = 100
const MAX_MEMORY_CHARS = 2_000

/** On-disk memory document. */
interface MemoryDocument {
  version: number
  entries: MemoryEntry[]
}

/**
 * Replace obvious credential values before accepting a local memory.
 * @param text - memory text to redact.
 * @returns the redacted memory text.
 */
export function redactMemorySecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password)\s*([=:])\s*[^\s,;]+/giu,
      (_match, name: string, separator: string) => `${name}${separator} [redacted]`)
}

/** Validate the persisted document before it can influence a prompt. */
function parseDocument(raw: string): MemoryDocument {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('memory document must be an object')
  const document = value as Partial<MemoryDocument>
  if (document.version !== MEMORY_FILE_VERSION || !Array.isArray(document.entries)) {
    throw new Error('memory document has an unsupported format')
  }
  for (const entry of document.entries) {
    if (typeof entry !== 'object' || entry === null
      || typeof entry.id !== 'string' || typeof entry.text !== 'string'
      || !Number.isSafeInteger(entry.createdAt) || !Number.isSafeInteger(entry.updatedAt)) {
      throw new Error('memory document contains an invalid entry')
    }
  }
  return { version: MEMORY_FILE_VERSION, entries: document.entries.map(entry => ({ ...entry })) }
}

/** JSON-backed local memory store, private to one BH home. */
export class LocalMemoryStore {
  private readonly path: string

  /** @param home - resolved BH home for this host. */
  constructor(home: string) {
    this.path = join(home, 'memories', 'memories.json')
  }

  /**
   * Read memory entries newest first.
   * @returns memory entries ordered by most recent update.
   */
  async list(): Promise<MemoryEntry[]> {
    const document = await this.read()
    return document.entries.toSorted((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * Append one already-redacted explicit memory.
   * @param text - memory text to redact and store.
   * @returns the newly stored memory entry.
   */
  async add(text: string): Promise<MemoryEntry> {
    const value = redactMemorySecrets(text).trim()
    if (value.length === 0 || value.length > MAX_MEMORY_CHARS) {
      throw new Error(`memory text must contain 1-${String(MAX_MEMORY_CHARS)} characters`)
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    // ponytail: one host-wide file lock; split stores only if memory writes become contended.
    return await withFileLock(this.path, async () => {
      const document = await this.read()
      if (document.entries.length >= MAX_MEMORY_ENTRIES) {
        throw new Error(`memory limit of ${String(MAX_MEMORY_ENTRIES)} entries reached; delete a memory first`)
      }
      const now = Date.now()
      const entry: MemoryEntry = { id: randomUUID(), text: value, createdAt: now, updatedAt: now }
      document.entries.push(entry)
      await this.write(document)
      return entry
    })
  }

  /**
   * Delete one memory id; returns whether an entry was removed.
   * @param id - identifier of the memory to delete.
   * @returns whether an entry was removed.
   */
  async remove(id: string): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return await withFileLock(this.path, async () => {
      const document = await this.read()
      const entries = document.entries.filter(entry => entry.id !== id)
      if (entries.length === document.entries.length) return false
      await this.write({ version: MEMORY_FILE_VERSION, entries })
      return true
    })
  }

  private async read(): Promise<MemoryDocument> {
    try {
      return parseDocument(await readFile(this.path, 'utf8'))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: MEMORY_FILE_VERSION, entries: [] }
      throw error
    }
  }

  private async write(document: MemoryDocument): Promise<void> {
    await writeFileAtomic(this.path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
  }
}
