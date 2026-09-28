/** Local durable attachment backend rooted below `HYDRA_HOME`. @module @hydraharness/harness-attachment-local */

import { join, resolve } from 'node:path'
import { Context } from '@hydraharness/cordis'
import z from '@hydraharness/schemastery'
import { AttachmentStore } from '@hydraharness/harness-attachment'
import type { FileAttachmentRef, ImageAttachmentLimits, ImageAttachmentRef, SaveFileAttachment, SaveFileStreamAttachment, SaveImageAttachment, StoredImageAttachment } from '@hydraharness/harness-attachment'
import { resolveHydraHome } from '@hydraharness/harness-home-paths'
import { readImageFile, saveImageFile, validateImageFile } from './store.ts'
import { readFileStreamVerbatim, saveFileStreamVerbatim, saveFileVerbatim, storedFilePath } from './file-store.ts'

export { readImageFile, saveImageFile, validateImageFile } from './store.ts'

/** Default maximum encoded bytes for one image. */
export const DEFAULT_MAX_IMAGE_BYTES = 3.5 * 1024 * 1024
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024
/** Default maximum intrinsic pixels for one image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 40_000_000
/**
 * Default maximum intrinsic width and height for one image. Deployed model
 * routes reject any request whose history carries an image with a side above
 * 2000px once the request holds many images, and an admitted image rides
 * every later request of its session, so admission refuses at the same line
 * to keep the durable history streamable.
 */
export const DEFAULT_MAX_IMAGE_DIMENSION = 2000

/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `HYDRA_HOME`, then `~/.hydra`. */
  hydraHome?: string
  /** Maximum encoded bytes accepted for one image. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one image. */
  maxImagePixels?: number
  /** Maximum intrinsic width and maximum intrinsic height accepted for one image. */
  maxImageDimension?: number
}

/** Persistent content-addressed local attachment store. */
export class LocalAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    hydraHome: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxImageDimension: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
  })

  /** Absolute versioned storage root. */
  readonly root: string
  readonly imageLimits: ImageAttachmentLimits

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve(join(resolveHydraHome(config.hydraHome), 'attachments', 'v1'))
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await validateImageFile(input, this.imageLimits)
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return saveImageFile(this.root, input, this.imageLimits)
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }

  override saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef> { return saveFileVerbatim(this.root, input) }
  override saveFileStream(input: SaveFileStreamAttachment): Promise<FileAttachmentRef> { return saveFileStreamVerbatim(this.root, input) }
  override readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    return readFileStreamVerbatim(this.root, ref, signal)
  }
  override fileHostPath(ref: FileAttachmentRef): string { return storedFilePath(this.root, ref) }
}

export default LocalAttachmentStore
