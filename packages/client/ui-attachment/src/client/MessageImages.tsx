import type { MessageImagesProps } from '@hydraharness/harness-client-ui-conversation/client'
import { ImageGallery } from '../MessageImage.tsx'
import { messageImageLabels } from './labels.ts'

/** Historical message-image slot entry. */
export function MessageImages({ images, loadImage, align, presentation, t }: MessageImagesProps) {
  return <ImageGallery images={images} load={loadImage} align={align} presentation={presentation} labels={messageImageLabels(t)} />
}
