import { describe, expect, it, vi } from 'vitest'
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

  it.each([
    ['GET', '?sessionId=s1', undefined, 405],
    ['POST', '?sessionId=s1', undefined, 415],
    ['POST', '', 'application/octet-stream', 400],
    ['POST', '?sessionId=', 'application/octet-stream', 400],
  ])('rejects %s %s with carrier %s', async (method, query, type, status) => {
    const uploadStream = vi.fn()
    const response = await handleFileUploadHttp({ uploadStream }, new Request(`http://hydra.test/${query}`, {
      method, ...(type === undefined ? {} : { headers: { 'content-type': type } }),
    }))
    expect(response.status).toBe(status)
    if (status === 405) expect(response.headers.get('allow')).toBe('POST')
    expect(uploadStream).not.toHaveBeenCalled()
  })

  it('passes an empty unnamed body and the request cancellation signal to the service', async () => {
    const request = new Request('http://hydra.test/?sessionId=s1', {
      method: 'POST', headers: { 'content-type': 'Application/Octet-Stream; charset=binary' },
    })
    const uploadStream = vi.fn(async (input: { data: AsyncIterable<Uint8Array> }) => {
      const chunks = []
      for await (const chunk of input.data) chunks.push(chunk)
      return chunks
    })
    const response = await handleFileUploadHttp({ uploadStream }, request)
    expect(uploadStream.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's1', signal: request.signal })
    expect(uploadStream.mock.calls[0]?.[0]).not.toHaveProperty('name')
    expect(await response.json()).toEqual({ ok: true, value: [] })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it.each([new Error('upload failed'), 'upload failed'])('returns a service rejection without caching it: %s', async (error) => {
    const response = await handleFileUploadHttp({ uploadStream: async () => { throw error } }, new Request('http://hydra.test/?sessionId=s1&name=', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' },
    }))
    expect(await response.json()).toEqual({ ok: false, error: { code: 'gateway/internal', message: 'upload failed', details: {} } })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
