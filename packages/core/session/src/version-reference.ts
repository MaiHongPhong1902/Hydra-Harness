/** Bounded transcript references for user-selected context and model reads. */
import { deriveEventMessage, isAppendSurfaceEvent } from './surface.ts'
import type { SessionEvent, SessionVersionId } from './types.ts'

/** One UTF-8-bounded reference page and its continuation offset. */
export interface SessionVersionReference { text: string; nextOffset: number | null }

/**
 * Render one page of stored prompt/response events, preserving their original sequence citations.
 * Images remain attachment descriptors; this text does not claim to decode their contents.
 * @param events - One selected transcript path.
 * @param versionId - Session-local identity printed in the reference.
 * @param maxBytes - Maximum UTF-8 bytes including page metadata.
 * @param offset - UTF-16 continuation offset from the previous page.
 * @returns A bounded page; continuation never splits a Unicode code point.
 */
export function sessionVersionReference(
  events: readonly SessionEvent[], versionId: SessionVersionId, maxBytes: number, offset = 0,
): SessionVersionReference {
  const content = events.filter(isAppendSurfaceEvent).flatMap((event) => {
    const message = deriveEventMessage(event)
    return message === null ? [] : [JSON.stringify({ seq: event.seq, role: message.role, content: message.content })]
  }).join('\n')
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > content.length) throw new Error('Invalid version reference offset.')
  const unit = content.charCodeAt(offset)
  if (unit >= 0xDC00 && unit <= 0xDFFF) throw new Error('Version reference offset splits a Unicode code point.')
  const header = `Referenced session version ${versionId}\nOffset ${offset}\n`
  const footer = (next: number | null) => `\nNext offset: ${next ?? 'end'}`
  const encoder = new TextEncoder()
  const overhead = encoder.encode(header).byteLength
    + Math.max(encoder.encode(footer(content.length)).byteLength, encoder.encode(footer(null)).byteLength)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < overhead + 4) throw new Error('Version reference byte limit is too small.')
  let used = overhead
  let end = offset
  for (const point of content.slice(offset)) {
    const bytes = encoder.encode(point).byteLength
    if (used + bytes > maxBytes) break
    used += bytes
    end += point.length
  }
  const nextOffset = end === content.length ? null : end
  return { text: header + content.slice(offset, end) + footer(nextOffset), nextOffset }
}
