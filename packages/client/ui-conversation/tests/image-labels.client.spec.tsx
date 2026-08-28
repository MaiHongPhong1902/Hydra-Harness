// @vitest-environment jsdom
// Conversation-owned attachment errors and the message-image slot handoff.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AttachmentId } from '@bosch/bh-attachment'
import { makeTranslate } from '@bosch/bh-client-test-runtime'
import { en as commonEn } from '@bosch/bh-client-locale/src/locales/en.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import type { RenderMessageImages } from '../src/client/contract/slots.ts'
import { attachmentErrorText, imageSizeText } from '../src/client/image-labels.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(en, commonEn)
const enT = makeTranslate(en, commonEn)

const attachment = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png' as const,
  bytes: 68,
  width: 640,
  height: 320,
  name: 'history.png',
}

type MessageImagesRenderOwner = Parameters<RenderMessageImages>[0]

function imageRenderer(calls: MessageImagesRenderOwner[]): RenderMessageImages {
  return (owner) => {
    calls.push(owner)
    return (
      <div data-testid="message-images" data-align={owner.align} data-count={owner.images.length}>
        {owner.images.map(({ attachment: image }, index) => (
          <span key={`${image.attachmentId}:${String(index)}`}>{image.name}</span>
        ))}
      </div>
    )
  }
}

describe('attachment rejection copy', () => {
  const limits = {
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 100 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    maxImageDimension: 2000,
    mediaTypes: ['image/png'] as const,
  }

  it('renders megabytes without a trailing fraction unless one exists', () => {
    expect(imageSizeText(10 * 1024 * 1024)).toBe('10MB')
    expect(imageSizeText(2.5 * 1024 * 1024)).toBe('2.5MB')
  })

  it('maps user-solvable reasons to limit-naming copy', () => {
    expect(attachmentErrorText(t, 'MODEL_DOES_NOT_SUPPORT_IMAGES')).toBe('The current model does not support images; switch to a model that does')
    expect(attachmentErrorText(t, 'SUBAGENT_IMAGE_UNSUPPORTED')).toBe('Subagent sessions do not support images yet')
    expect(attachmentErrorText(t, 'IMAGE_TOO_MANY_PIXELS')).toBe('Image resolution is too high; compress it and try again')
    expect(attachmentErrorText(t, 'INVALID_IMAGE')).toBe('Only PNG, JPG, WebP, and GIF images are supported')
    expect(attachmentErrorText(t, 'IMAGE_TYPE_MISMATCH')).toBe('Only PNG, JPG, WebP, and GIF images are supported')
    expect(attachmentErrorText(t, 'TOO_MANY_IMAGES', limits)).toBe('A message can include up to 20 images')
    expect(attachmentErrorText(t, 'IMAGE_TOO_LARGE', limits)).toBe('Each image must be smaller than 5MB')
    expect(attachmentErrorText(t, 'IMAGES_TOO_LARGE', limits)).toBe('Images exceed 100MB in total; remove some and try again')
    expect(attachmentErrorText(t, 'IMAGE_DIMENSION_TOO_LARGE', limits)).toBe('Image sides must be at most 2000px; downscale it and try again')
    expect(attachmentErrorText(enT, 'TOO_MANY_IMAGES', limits)).toBe('A message can include up to 20 images')
  })

  it('folds unknown reasons and limit reasons without projected limits into the send-failed line', () => {
    expect(attachmentErrorText(t, 'INVALID_IMAGE_BASE64')).toBe('Sending images failed (INVALID_IMAGE_BASE64); re-add them and try again')
    expect(attachmentErrorText(t, 'TOO_MANY_IMAGES')).toBe('Sending images failed (TOO_MANY_IMAGES); re-add them and try again')
    expect(attachmentErrorText(t, 'IMAGE_TOO_LARGE')).toBe('Sending images failed (IMAGE_TOO_LARGE); re-add them and try again')
    expect(attachmentErrorText(t, 'IMAGES_TOO_LARGE')).toBe('Sending images failed (IMAGES_TOO_LARGE); re-add them and try again')
    expect(attachmentErrorText(t, 'IMAGE_DIMENSION_TOO_LARGE')).toBe('Sending images failed (IMAGE_DIMENSION_TOO_LARGE); re-add them and try again')
  })
})

describe('assistant image slot handoff', () => {
  it('passes one image group and its message alignment to the renderer', () => {
    const calls: MessageImagesRenderOwner[] = []
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'image', attachment }]}
        streaming={false}
        renderMessageImages={imageRenderer(calls)}
      />,
    )
    expect(view.getByTestId('message-images').getAttribute('data-align')).toBe('start')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.images).toEqual([{ attachment }])
  })

  it('merges consecutive image blocks into one group and splits groups at text', () => {
    const calls: MessageImagesRenderOwner[] = []
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[
          { kind: 'image', attachment },
          { kind: 'image', attachment },
          { kind: 'text', text: 'between' },
          { kind: 'image', attachment },
        ]}
        streaming={false}
        renderMessageImages={imageRenderer(calls)}
      />,
    )
    const galleries = view.getAllByTestId('message-images')
    expect(galleries).toHaveLength(2)
    expect(galleries.map(gallery => gallery.getAttribute('data-count'))).toEqual(['2', '1'])
    expect(calls.map(call => call.images.length)).toEqual([2, 1])
  })

  it('keeps the renderer output at the image block position between text blocks', () => {
    const calls: MessageImagesRenderOwner[] = []
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[
          { kind: 'text', text: 'before' },
          { kind: 'image', attachment },
          { kind: 'text', text: 'after' },
        ]}
        streaming={false}
        renderMessageImages={imageRenderer(calls)}
      />,
    )
    const image = view.getByTestId('message-images')
    const before = view.getByText('before')
    const after = view.getByText('after')
    expect(before.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(image.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })
})
