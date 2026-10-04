import { describe, expect, it } from 'vitest'
import { toolImageReferences, toolVideoReferences, toolMediaLabels } from '../src/index.ts'

const image = { attachmentId: 'opaque', mediaType: 'image/png', bytes: 68, width: 1, height: 1, name: 'generated.png' }

describe('tool image presentation metadata', () => {
  it('accepts opaque references and ignores unrelated metadata', () => {
    expect(toolImageReferences({ kind: 'tool-images', images: [image, { ...image, name: undefined }] })).toHaveLength(2)
    for (const meta of [undefined, null, 1, {}, { kind: 'other', images: [image] }]) expect(toolImageReferences(meta)).toEqual([])
  })

  it('rejects malformed recognized metadata before authorizing bytes', () => {
    for (const images of [undefined, {}, [null], [1], [{ ...image, attachmentId: '' }], [{ ...image, attachmentId: 1 }],
      [{ ...image, mediaType: 'text/plain' }], [{ ...image, mediaType: undefined }], [{ ...image, bytes: 0 }],
      [{ ...image, width: 1.5 }], [{ ...image, height: '1' }], [{ ...image, name: 1 }]]) {
      expect(() => toolImageReferences({ kind: 'tool-images', images })).toThrow('Invalid tool-image')
    }
  })
})

it('validates stored video references before authorizing bytes', () => {
  const video = { attachmentId: 'opaque', name: 'generated.mp4', mediaType: 'video/mp4', bytes: 80 }
  expect(toolVideoReferences({ kind: 'tool-videos', videos: [video, { ...video, mediaType: 'video/webm' }] })).toHaveLength(2)
  for (const meta of [undefined, null, 1, {}, { kind: 'other' }]) expect(toolVideoReferences(meta)).toEqual([])
  for (const videos of [undefined, {}, [null], [1], [{ ...video, attachmentId: '' }], [{ ...video, attachmentId: 1 }],
    [{ ...video, mediaType: undefined }], [{ ...video, mediaType: 'video/avi' }], [{ ...video, bytes: '1' }],
    [{ ...video, bytes: 1.5 }], [{ ...video, bytes: 0 }], [{ ...video, name: undefined }], [{ ...video, name: '' }], [{ ...video, name: '../a.mp4' }]]) {
    expect(() => toolVideoReferences({ kind: 'tool-videos', videos })).toThrow('Invalid tool-video')
  }
})

it('reads only display labels from media metadata', () => {
  for (const meta of [undefined, null, 1, {}, { model: 1, provider: 2 }]) expect(toolMediaLabels(meta)).toEqual({})
  expect(toolMediaLabels({ model: 'image-model', provider: 'chosen-route' })).toEqual({ model: 'image-model', provider: 'chosen-route' })
})
