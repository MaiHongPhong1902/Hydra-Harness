/** Bounded, stored diff evidence with PI Desktop's preview limits. @module */
import { structuredPatch } from 'diff'
import type { ReviewChange } from './types.ts'

/** Deployment limits for snapshot storage and preview work. */
export interface ReviewLimits {
  /** Inclusive before-snapshot byte cap; larger files retain hashes only. */
  snapshotMaxBytes: number
  /** Inclusive text-preview byte cap for each side. */
  diffMaxBytes: number
  /** Inclusive text-preview line cap for each side. */
  diffMaxLines: number
  /** Maximum product of the two line counts plus their empty-prefix rows. */
  diffMaxCells: number
}

/**
 * Compute persisted counts/hunks without re-reading the workspace on review.
 * @param before - bounded raw before bytes; null marks unavailable content.
 * @param after - bounded raw after bytes; null marks unavailable content.
 * @param limits - inclusive per-side limits and diff work bound.
 * @returns preview evidence or an explicit binary/truncated marker.
 */
export function preview(before: Uint8Array | null, after: Uint8Array | null, limits: ReviewLimits): Pick<ReviewChange, 'binary' | 'truncated' | 'additions' | 'deletions' | 'hunks'> {
  const empty = { binary: false, truncated: false, additions: 0, deletions: 0, hunks: [] }
  if (!before || !after || before.length > limits.diffMaxBytes || after.length > limits.diffMaxBytes) return { ...empty, truncated: true }
  if (before.includes(0) || after.includes(0)) return { ...empty, binary: true }
  let oldText: string
  let newText: string
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    oldText = decoder.decode(before).replaceAll('\r\n', '\n')
    newText = decoder.decode(after).replaceAll('\r\n', '\n')
  } catch (_invalidUtf8) {
    return { ...empty, binary: true }
  }
  const count = (text: string) => text === '' ? 0 : text.split('\n').length - Number(text.endsWith('\n'))
  const oldLines = count(oldText)
  const newLines = count(newText)
  if (oldLines > limits.diffMaxLines || newLines > limits.diffMaxLines
    || (oldLines + 1) * (newLines + 1) > limits.diffMaxCells) return { ...empty, truncated: true }
  const patch = structuredPatch('', '', oldText, newText, undefined, undefined, { context: 3 })
  let additions = 0
  let deletions = 0
  const hunks = patch.hunks.map((hunk) => {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions++
      if (line.startsWith('-')) deletions++
    }
    return { header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, lines: hunk.lines }
  })
  return { ...empty, additions, deletions, hunks }
}
