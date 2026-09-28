/** Wire-form admission of base64-encoded image uploads. @module @hydraharness/harness-attachment/admission */

import { Buffer } from 'node:buffer'
import { AttachmentError } from './error.ts'
import type { AttachmentStore } from './index.ts'
import type { EncodedFileAttachment, EncodedImageAttachment, FileAttachmentRef, ImageAttachmentRef, SaveImageAttachment } from './types.ts'

/** Decode one upload payload while rejecting non-canonical base64 forms. */
function decodeBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if (data.length === 0 || decoded.toString('base64') !== data) {
    throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64')
  }
  return new Uint8Array(decoded)
}

/**
 * Admit one generic file upload, including zero-byte files.
 * @param attachments - attachment store that owns durable file storage.
 * @param file - canonical base64 upload and optional display name.
 * @returns the durable file reference.
 */
export async function admitEncodedFile(attachments: AttachmentStore, file: EncodedFileAttachment): Promise<FileAttachmentRef> {
  const decoded = Buffer.from(file.data, 'base64')
  if ((file.data.length > 0 && decoded.toString('base64') !== file.data)) {
    throw new AttachmentError('File upload is not canonical base64.', 'INVALID_FILE_BASE64')
  }
  return attachments.saveFile({ data: new Uint8Array(decoded), ...(file.name === undefined ? {} : { name: file.name }) })
}

/** Store input for one decoded upload. */
function saveInput(image: EncodedImageAttachment): SaveImageAttachment {
  return {
    data: decodeBase64(image.data),
    mediaType: image.mediaType,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * Admit one wire image batch: enforce canonical base64 on every member, then
 * delegate batch admission — count and aggregate-byte limits, media-type and
 * per-image validation, ordered commit — to {@link AttachmentStore.saveImages}.
 * The shared entry for every RPC endpoint accepting browser uploads.
 * @param attachments - the deployment attachment store owning batch policy.
 * @param images - base64-encoded uploads in caller order.
 * @returns durable references in the same order as `images`.
 * @throws AttachmentError on a non-canonical payload or a refused batch.
 */
export async function admitEncodedImages(
  attachments: AttachmentStore,
  images: readonly EncodedImageAttachment[],
): Promise<readonly ImageAttachmentRef[]> {
  return attachments.saveImages(images.map(saveInput))
}
