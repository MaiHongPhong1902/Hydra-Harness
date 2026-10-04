/** Durable images shown with a tool result without entering model history. */
import type { ImageAttachmentRef, ToolImagePresentationMeta, ToolVideoPresentationMeta, VideoAttachmentRef } from './types.ts'

/**
 * Read image references from recognized tool presentation metadata.
 * @param meta - untrusted durable presentation metadata.
 * @returns validated image references, or an empty list for other metadata.
 * @throws TypeError when recognized metadata contains an invalid reference.
 */
export function toolImageReferences(meta: unknown): readonly ImageAttachmentRef[] {
  if (typeof meta !== 'object' || meta === null || !('kind' in meta) || meta.kind !== 'tool-images') return []
  const images: unknown = (meta as Partial<ToolImagePresentationMeta>).images
  if (!Array.isArray(images) || images.some((image: unknown) => {
    if (typeof image !== 'object' || image === null) return true
    const ref = image as Partial<ImageAttachmentRef>
    return typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType ?? '')
      || ![ref.bytes, ref.width, ref.height].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      || (ref.name !== undefined && typeof ref.name !== 'string')
  })) throw new TypeError('Invalid tool-image presentation metadata.')
  return images as ImageAttachmentRef[]
}

/**
 * Read durable video references from tool presentation metadata.
 * @param meta - untrusted durable presentation metadata.
 * @returns validated video references, or an empty list for other metadata.
 * @throws TypeError when recognized metadata contains an invalid reference.
 */
export function toolVideoReferences(meta: unknown): readonly VideoAttachmentRef[] {
  if (typeof meta !== 'object' || meta === null || !('kind' in meta) || meta.kind !== 'tool-videos') return []
  const videos: unknown = (meta as Partial<ToolVideoPresentationMeta>).videos
  if (!Array.isArray(videos) || videos.some((video: unknown) => {
    if (typeof video !== 'object' || video === null) return true
    const ref = video as Partial<VideoAttachmentRef>
    return typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0
      || !['video/mp4', 'video/webm'].includes(ref.mediaType ?? '')
      || typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0
      || typeof ref.name !== 'string' || ref.name.length === 0 || /[\\/\u0000-\u001f\u007f]/u.test(ref.name)
  })) throw new TypeError('Invalid tool-video presentation metadata.')
  return videos as VideoAttachmentRef[]
}

/**
 * Read the actual generating route's display labels from durable metadata.
 * @param meta - tool presentation metadata.
 * @returns only string-valued provider and model labels.
 */
export function toolMediaLabels(meta: unknown): { model?: string; provider?: string } {
  if (typeof meta !== 'object' || meta === null) return {}
  return {
    ...'model' in meta && typeof meta.model === 'string' ? { model: meta.model } : {},
    ...'provider' in meta && typeof meta.provider === 'string' ? { provider: meta.provider } : {},
  }
}
