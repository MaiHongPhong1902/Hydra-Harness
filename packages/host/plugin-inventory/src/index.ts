/** Runtime plugin inventory plus profile-owned enablement controls. */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context, FiberState } from '@bosch/cordis'
import type { Entry } from '@bosch/cordis-plugin-loader'
import { entryListSchema, type Include, type PatchOptions } from '@bosch/cordis-plugin-include'
import { withFileLock, writeFileAtomic } from '@bosch/bh-atomic-write'
import { TypertRemoteService, Remote } from '@bosch/bh-typert-protocol'
import z from '@bosch/schemastery'
import * as yaml from 'js-yaml'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  PluginEnablementRequest,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
const MANAGED_BEGIN = '# BEGIN BH plugin switches'
const MANAGED_END = '# END BH plugin switches'

/** Plugin ids whose removal would strand the in-app control path. */
export interface Config {
  /** Direct root entry ids that must stay enabled to preserve the control path. */
  protectedEntryIds?: string[]
}

function parsePatchList(source: string, label: string): PatchOptions[] {
  let parsed: unknown
  try {
    parsed = yaml.load(source, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`pluginInventory: invalid ${label}: ${String(error)}`)
  }
  if (!Array.isArray(parsed) || parsed.some(row => typeof row !== 'object' || row === null)) {
    throw new Error(`pluginInventory: ${label} must be a YAML patch list`)
  }
  return parsed as PatchOptions[]
}

/** Replace only the app-owned suffix block, preserving user YAML and comments. */
function renderPluginSwitch(source: string, id: string, enabled: boolean): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  const begins = lines.flatMap((line, index) => line === MANAGED_BEGIN ? [index] : [])
  const ends = lines.flatMap((line, index) => line === MANAGED_END ? [index] : [])
  if (begins.length !== ends.length || begins.length > 1 || (begins[0] ?? -1) > (ends[0] ?? Infinity)) {
    throw new Error('pluginInventory: malformed managed plugin-switch block')
  }

  const allRows = parsePatchList(source, PROFILE_PATCH_FILENAME)
  let prefix = lines
  let suffix: string[] = []
  let managedRows: PatchOptions[] = []
  if (begins.length === 1) {
    const begin = begins[0]
    const end = ends[0]
    if (begin === undefined || end === undefined) {
      throw new Error('pluginInventory: malformed managed plugin-switch block')
    }
    prefix = lines.slice(0, begin)
    suffix = lines.slice(end + 1)
    managedRows = parsePatchList(lines.slice(begin + 1, end).join('\n') || '[]\n', 'managed plugin-switch block')
  } else if (allRows.length === 0) {
    const emptyList = lines.flatMap((line, index) => line.trim() === '[]' ? [index] : [])
    if (emptyList.length !== 1) {
      throw new Error('pluginInventory: empty patch file must use the standard [] document')
    }
    prefix = lines.filter((_, index) => index !== emptyList[0])
  } else {
    const firstYaml = lines.find(line => line.trim().length > 0 && !line.trimStart().startsWith('#'))
    if (!firstYaml?.trimStart().startsWith('-')) {
      throw new Error('pluginInventory: flow-style patch lists cannot contain managed plugin switches')
    }
  }

  const switches = new Map<string, boolean>()
  for (const row of managedRows) {
    const keys = Object.keys(row)
    if (typeof row.id !== 'string'
      || typeof row.disabled !== 'boolean'
      || keys.some(key => key !== 'id' && key !== 'disabled')) {
      throw new Error('pluginInventory: managed plugin-switch rows must contain only id and disabled')
    }
    switches.set(row.id, row.disabled)
  }
  switches.set(id, !enabled)

  const block = [
    MANAGED_BEGIN,
    ...[...switches].flatMap(([entryId, disabled]) => [
      `- id: ${JSON.stringify(entryId)}`,
      `  disabled: ${String(disabled)}`,
    ]),
    MANAGED_END,
  ]
  const rendered = [...prefix, ...block, ...suffix].join(eol) + eol
  parsePatchList(rendered, PROFILE_PATCH_FILENAME)
  return rendered
}

async function readPatchFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '[]\n'
    throw error
  }
}

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']
  static Config: z<Config> = z.object({
    protectedEntryIds: z.array(z.string()).default([]),
  })

  private readonly protectedEntryIds: ReadonlySet<string>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'pluginInventory')
    this.protectedEntryIds = new Set(config.protectedEntryIds)
  }

  private rootInclude(): Include | undefined {
    return Object.values(this.ctx.loader.store)
      .map(entry => entry.subtree)
      .find((tree): tree is Include => tree !== undefined
        && 'filename' in tree
        && typeof tree.filename === 'string')
  }

  private isToggleable(entry: Entry, rootInclude = this.rootInclude()): boolean {
    return rootInclude !== undefined
      && entry.parent.tree === rootInclude
      && !this.protectedEntryIds.has(entry.options.id)
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   * @returns Current non-group Loader entries in Loader order.
   */
  @Remote('list')
  list(): PluginInventorySnapshot {
    const entries: PluginInventoryEntry[] = []
    const rootInclude = this.rootInclude()
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        toggleable: this.isToggleable(entry, rootInclude),
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      })
    }
    return { entries }
  }

  /**
   * Apply enablement to the live entry, then persist the same override in the
   * profile patch. A failed write rolls the live entry back.
   * @param request - target entry and desired enablement.
   * @returns A fresh inventory snapshot after the mutation.
   */
  @Remote('setEnabled')
  async setEnabled(request: PluginEnablementRequest): Promise<PluginInventorySnapshot> {
    const rootInclude = this.rootInclude()
    const entry = this.ctx.loader.resolve(request.entryId)
    if (!this.isToggleable(entry, rootInclude) || rootInclude === undefined) {
      throw new Error(`pluginInventory: entry ${request.entryId} cannot be toggled in-app`)
    }
    if (request.enabled === !entry.disabled) return this.list()

    const patchPath = join(dirname(rootInclude.filename), PROFILE_PATCH_FILENAME)
    await withFileLock(patchPath, async () => {
      const rendered = renderPluginSwitch(await readPatchFile(patchPath), entry.options.id, request.enabled)
      const previousDisabled = entry.options.disabled
      await entry.update({ disabled: request.enabled ? null : true })
      try {
        await writeFileAtomic(patchPath, rendered, { mode: 0o600, dirMode: 0o700 })
      } catch (error) {
        try {
          await entry.update({ disabled: previousDisabled ?? null })
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `pluginInventory: failed to persist and roll back ${request.entryId}`)
        }
        throw error
      }
    })
    return this.list()
  }
}

export default PluginInventoryGateway
