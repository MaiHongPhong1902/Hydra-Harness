import { describe, expect, it } from 'vitest'
import { handleFileUploadHttp } from '../src/file-upload-route.ts'

describe('generic file upload HTTP route', () => {
  it('validates the carrier and streams bytes to the service', async () => {
    const chunks: number[] = []
    const service = {
      async uploadStream(input: { data: AsyncIterable<Uint8Array> }) {
        for await (const chunk of input.data) chunks.push(...chunk)
        return { receiptId: 'r1', attachment: { name: 'a.txt', bytes: chunks.length } }
      },
    }
    const response = await handleFileUploadHttp(service, new Request('http://hydra.test/api/session/uploadFileBinary?sessionId=s1&name=a.txt', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    }))
    expect(response.status).toBe(200)
    expect(chunks).toEqual([1, 2, 3])
    expect(await response.json()).toMatchObject({ ok: true, value: { receiptId: 'r1' } })
  })

  it('rejects non-binary carriers before invoking the service', async () => {
    const response = await handleFileUploadHttp({ uploadStream: async () => ({}) }, new Request('http://hydra.test/?sessionId=s1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    expect(response.status).toBe(415)
  })
})
