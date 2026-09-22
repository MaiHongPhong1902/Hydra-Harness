import { Context } from '@hydra/cordis'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import LocalAttachmentStore, {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_DIMENSION,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_IMAGES_PER_MESSAGE,
  DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
} from '../src/index.ts'

describe('local attachment service', () => {
  it('persists and streams files through the mounted service', async () => {
    const hydraHome = await mkdtemp(join(tmpdir(), 'hydra-attachment-files-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { hydraHome })
      const data = Uint8Array.of(0, 1, 2)
      const saved = await service.saveFile({ data, name: 'bytes.bin' })
      const streamed = await service.saveFileStream({ data: (async function* () { yield data })(), name: 'bytes.bin' })
      expect(streamed).toEqual(saved)
      const chunks: Uint8Array[] = []
      for await (const chunk of service.readFileStream(saved)) chunks.push(chunk)
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(data))
      await expect(readFile(service.fileHostPath(saved))).resolves.toEqual(Buffer.from(data))
      const reason = new Error('read cancelled')
      await expect(service.readFileStream(saved, AbortSignal.abort(reason))[Symbol.asyncIterator]().next())
        .rejects.toBe(reason)
    } finally {
      await rm(hydraHome, { recursive: true, force: true })
    }
  })

  it('resolves every omitted admission limit explicitly', () => {
    const service = new LocalAttachmentStore(new Context(), {})
    expect(DEFAULT_MAX_IMAGE_BYTES).toBe(3.5 * 1024 * 1024)
    expect(service.imageLimits).toEqual({
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    })
  })

  it('saves and reads through the service boundary', async () => {
    const hydraHome = await mkdtemp(join(tmpdir(), 'hydra-attachment-service-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { hydraHome })
      const data = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ))
      const ref = await service.saveImage({ data, mediaType: 'image/png' })
      await expect(service.readImage(ref)).resolves.toEqual({ ref, data })
    } finally {
      await rm(hydraHome, { recursive: true, force: true })
    }
  })

  it('validates without persisting: a rejected image leaves no storage root behind', async () => {
    const hydraHome = await mkdtemp(join(tmpdir(), 'hydra-attachment-validate-'))
    try {
      const service = new LocalAttachmentStore(new Context(), { hydraHome })
      await expect(service.validateImage({ data: Uint8Array.of(1, 2, 3), mediaType: 'image/png' }))
        .rejects.toThrow(/Unsupported or malformed image data/)
      const valid = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ))
      const limited = new LocalAttachmentStore(new Context(), { hydraHome, maxImageBytes: 1 })
      await expect(limited.validateImage({ data: valid, mediaType: 'image/png' }))
        .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
      await expect(service.validateImage({ data: valid, mediaType: 'image/png' })).resolves.toBeUndefined()
      expect(existsSync(service.root)).toBe(false)
    } finally {
      await rm(hydraHome, { recursive: true, force: true })
    }
  })
})
