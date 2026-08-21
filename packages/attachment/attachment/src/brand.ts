/** Attachment identifier brand. @module @bosch/bh-attachment/brand */

import type { Branded } from '@bosch/bh-brand'

/** Opaque content-addressed identifier for one immutable attachment object. */
export type AttachmentId = Branded<'AttachmentId'>

/**
 * Brand a validated storage identifier.
 * @param value - backend-produced opaque identifier.
 * @returns the branded identifier.
 */
export function AttachmentId(value: string): AttachmentId {
  return value as AttachmentId
}
