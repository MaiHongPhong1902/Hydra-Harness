import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore } from '@hydraharness/harness-attachment'
import { admitEncodedFile, admitEncodedImages, AttachmentId } from '@hydraharness/harness-attachment'
import type { ImageAttachmentRef, SaveImageAttachment } from '@hydraharness/harness-attachment/types'

const PNG = 'AAAA' // canonical base64, 3 bytes

/** Delegation double: records the exact saveImages batch and answers ordered refs. */
function storeOf() {
  const store = {
    saveImages: vi.fn((inputs: readonly SaveImageAttachment[]) => Promise.resolve(inputs.map((input, index): ImageAttachmentRef => ({
      attachmentId: `att-${index + 1}` as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    })))),
  }
  return { store: store as unknown as AttachmentStore, mocks: store }
}

describe('admitEncodedImages', () => {
  it('decodes every member and delegates one ordered batch to saveImages', async () => {
    const { store, mocks } = storeOf()
    const refs = await admitEncodedImages(store, [
      { mediaType: 'image/png', data: PNG, name: 'first.png' },
      { mediaType: 'image/jpeg', data: PNG, name: 'second.jpg' },
    ])
    expect(mocks.saveImages).toHaveBeenCalledTimes(1)
    const batch = mocks.saveImages.mock.calls[0]?.[0] as readonly SaveImageAttachment[]
    expect(batch.map(input => [input.name, input.mediaType, input.data.byteLength]))
      .toEqual([['first.png', 'image/png', 3], ['second.jpg', 'image/jpeg', 3]])
    expect(refs.map(ref => ref.attachmentId)).toEqual(['att-1', 'att-2'])
  })

  it('omits the name from store inputs when the upload has none', async () => {
    const { store, mocks } = storeOf()
    const refs = await admitEncodedImages(store, [{ mediaType: 'image/webp', data: PNG }])
    const batch = mocks.saveImages.mock.calls[0]?.[0] as readonly SaveImageAttachment[]
    expect('name' in (batch[0] as object)).toBe(false)
    expect(refs[0]?.name).toBeUndefined()
  })

  it('delegates an empty batch unchanged', async () => {
    const { store, mocks } = storeOf()
    await expect(admitEncodedImages(store, [])).resolves.toEqual([])
    expect(mocks.saveImages).toHaveBeenCalledWith([])
  })

  it('rejects non-canonical and empty base64 payloads before any store call', async () => {
    const { store, mocks } = storeOf()
    for (const data of ['', 'AAA', '!!!!']) {
      await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data }]))
        .rejects.toMatchObject({ name: 'AttachmentError', code: 'INVALID_IMAGE_BASE64' })
    }
    expect(mocks.saveImages).not.toHaveBeenCalled()
  })

  it('propagates the store batch rejection unchanged', async () => {
    const { store, mocks } = storeOf()
    const refused = Object.assign(new Error('Image batch exceeds the configured image-count limit.'), { code: 'TOO_MANY_IMAGES' })
    mocks.saveImages.mockRejectedValueOnce(refused)
    await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data: PNG }])).rejects.toBe(refused)
  })
})

describe('admitEncodedFile', () => {
  it('preserves decoded bytes and optional names, including empty files', async () => {
    const ref = { attachmentId: AttachmentId('sha256:fixture'), bytes: 3, name: 'file.bin' }
    const saveFile = vi.fn().mockResolvedValue(ref)
    const store = { saveFile } as unknown as AttachmentStore
    await expect(admitEncodedFile(store, { data: 'AAEC', name: 'file.bin' })).resolves.toBe(ref)
    expect(saveFile).toHaveBeenLastCalledWith({ data: Uint8Array.of(0, 1, 2), name: 'file.bin' })
    await admitEncodedFile(store, { data: '' })
    expect(saveFile).toHaveBeenLastCalledWith({ data: new Uint8Array() })
  })

  it.each(['AAA', '!!!!', 'AAEC\n', 'AB=='])('rejects non-canonical base64 %j before saving', async (data) => {
    const saveFile = vi.fn()
    await expect(admitEncodedFile({ saveFile } as unknown as AttachmentStore, { data }))
      .rejects.toMatchObject({ code: 'INVALID_FILE_BASE64' })
    expect(saveFile).not.toHaveBeenCalled()
  })
})
