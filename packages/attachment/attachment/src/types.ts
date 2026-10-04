/** Durable attachment vocabulary. @module @hydraharness/harness-attachment/types */

import type { AttachmentId } from './brand.ts'

export type { AttachmentId } from './brand.ts'

/** Raster image formats accepted by the version-one attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Durable, serializable metadata for one immutable image object. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}

/** Tool-result presentation images, excluded from derived model messages. */
export interface ToolImagePresentationMeta {
  kind: 'tool-images'
  images: ImageAttachmentRef[]
}

/** Stored video bytes presented to users without entering model history. */
export interface VideoAttachmentRef extends FileAttachmentRef {
  mediaType: 'video/mp4' | 'video/webm'
}

/** Tool-result videos read through session-authorized attachment access. */
export interface ToolVideoPresentationMeta {
  kind: 'tool-videos'
  videos: VideoAttachmentRef[]
}

/** Durable reference to verbatim stored file bytes. */
export interface FileAttachmentRef { attachmentId: AttachmentId; name: string; bytes: number }
/** Base64-encoded file upload. */
export interface EncodedFileAttachment { data: string; name?: string }
/** Request to persist exact file bytes. */
export interface SaveFileAttachment { data: Uint8Array; name?: string }
/** Streamed request to persist exact file bytes. */
export interface SaveFileStreamAttachment { data: AsyncIterable<Uint8Array>; signal?: AbortSignal; name?: string }

/** Deployment-resolved limits used by upload admission and request buffering. */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}

/** Base64-encoded image upload accompanying one wire request. */
export interface EncodedImageAttachment {
  /** Declared media type, verified against the decoded bytes during admission. */
  mediaType: ImageMediaType
  /** Canonical base64 encoding of the image bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}

/** Request to validate and durably commit one image. */
export interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}

/** Stored image bytes returned after reference and digest verification. */
export interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}
