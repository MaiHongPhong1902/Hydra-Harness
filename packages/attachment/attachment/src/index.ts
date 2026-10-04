/** Durable attachment storage seam (`ctx.attachments`). @module @hydraharness/harness-attachment */

import { Context, Service } from '@hydraharness/cordis'
import { AttachmentError } from './error.ts'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  FileAttachmentRef,
  SaveFileAttachment,
  SaveFileStreamAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from './types.ts'

export { AttachmentId } from './brand.ts'
export { AttachmentError, isImageAdmissionError } from './error.ts'
export type { AttachmentErrorCode, ImageAdmissionErrorCode } from './error.ts'
export { admitEncodedFile, admitEncodedImages } from './admission.ts'
export { toolImageReferences, toolVideoReferences, toolMediaLabels } from './presentation.ts'
export type {
  AttachmentId as AttachmentIdType,
  EncodedImageAttachment,
  EncodedFileAttachment,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  FileAttachmentRef,
  ImageMediaType,
  ToolImagePresentationMeta,
  VideoAttachmentRef,
  ToolVideoPresentationMeta,
  SaveImageAttachment,
  SaveFileAttachment,
  SaveFileStreamAttachment,
  StoredImageAttachment,
} from './types.ts'

declare module '@hydraharness/cordis' {
  interface Context {
    attachments: AttachmentStore
  }
}

/** Immutable binary attachment service. Implementations validate bytes before publishing a reference. */
export abstract class AttachmentStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  /** Deployment-resolved image policy used by authoritative and fast-path validation. */
  abstract readonly imageLimits: ImageAttachmentLimits

  /**
   * Validate one image without persisting it.
   * Batch callers validate every member before saving any member.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns completion after the encoded raster has been fully decoded.
   */
  abstract validateImage(input: SaveImageAttachment): Promise<void>

  /**
   * Validate one ordered image batch before committing any member.
   * Validation failures start no writes; storage failures return no partial
   * references, although already published content-addressed objects may stay
   * unreachable until a future retention policy collects them.
   * @param inputs - encoded images in their owning message order.
   * @returns durable references in the exact input order.
   */
  async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    const { maxImagesPerMessage, maxMessageImageBytes, mediaTypes } = this.imageLimits
    if (inputs.length > maxImagesPerMessage) {
      throw new AttachmentError('Image batch exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
    }
    const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > maxMessageImageBytes) {
      throw new AttachmentError('Image batch exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
    }
    for (const input of inputs) {
      if (!mediaTypes.includes(input.mediaType)) {
        throw new AttachmentError(`Image type ${input.mediaType} is not accepted by this deployment.`, 'UNSUPPORTED_IMAGE_TYPE')
      }
    }
    for (const input of inputs) await this.validateImage(input)

    const refs: ImageAttachmentRef[] = []
    for (const input of inputs) refs.push(await this.saveImage(input))
    return refs
  }

  /**
   * Validate and durably commit one image before its owning session event is appended.
   * @param input - encoded bytes, declared media type, and optional display name.
   * @returns a durable content-addressed reference.
   */
  abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

  /**
   * Read one image and verify that bytes still match the recorded reference.
   * @param ref - durable reference from the session log.
   * @param signal - optional cancellation for backend read and verification work.
   * @returns the verified bytes and canonical reference.
   * @throws the signal reason when aborted, or a storage error when verification fails.
   */
  abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>

  /**
   * Persist one file verbatim and return its durable reference.
   * @param input - complete file bytes and optional display name.
   * @returns the content-addressed durable reference.
   */
  saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> {
    void input
    return Promise.reject(new AttachmentError('The mounted attachment provider cannot store files.', 'ATTACHMENT_FILES_UNSUPPORTED'))
  }

  /**
   * Persist streamed file bytes without requiring one complete input buffer.
   * @param input - ordered byte chunks, cancellation, and optional display name.
   * @returns the content-addressed durable reference.
   */
  saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> {
    void input
    return Promise.reject(new AttachmentError('The mounted attachment provider cannot store files.', 'ATTACHMENT_FILES_UNSUPPORTED'))
  }

  /**
   * Read one durable file as verified byte chunks.
   * @param ref - durable file reference to verify.
   * @param signal - optional cancellation signal.
   * @returns an async sequence of exact file bytes.
   */
  async *readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    signal?.throwIfAborted(); void ref
    await Promise.reject(new AttachmentError('The mounted attachment provider cannot read files.', 'ATTACHMENT_FILES_UNSUPPORTED'))
  }

  /**
   * Resolve a durable file to a host path when this provider is host-backed.
   * @param ref - durable file reference.
   * @returns an absolute host path, or undefined when unavailable.
   */
  fileHostPath(ref: FileAttachmentRef): string | undefined { void ref; return undefined }
}

export default AttachmentStore
