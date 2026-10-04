/** Accepted-job polling preserves route identity, request bounds, and download authority. */
import { expect, it } from 'vitest'
import { completeVideoGeneration } from '../src/video-generation.ts'

const baseURL = 'http://127.0.0.1:1234/v1beta'
const operation = 'models/veo-3.1-generate-preview/operations/job-1'
const options = () => ({ endpoint: 'videos' as const, body: {}, maxResponseBytes: 1024, signal: new AbortController().signal, pollIntervalMs: 1 })
const content = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } })
const done = (uri = `${baseURL}/files/video:download`) => ({ name: operation, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } })

it.each(['google', 'openai', 'xai'] as const)('completes an accepted %s job with GETs only', async (protocol) => {
  const initial = protocol === 'google' ? { name: operation } : protocol === 'openai' ? { id: 'job-1', status: 'queued' } : { request_id: 'job-1' }
  const complete = protocol === 'google' ? done() : protocol === 'openai' ? { id: 'job-1', status: 'completed' } : { request_id: 'job-1', status: 'done', video: { url: `${baseURL}/output.mp4` } }
  const calls: Array<{ url: string; authenticated: boolean }> = []
  const result = await completeVideoGeneration(Response.json(initial), { protocol, baseURL }, async (url, authenticated) => {
    calls.push({ url: url.href, authenticated })
    return calls.length === 1 ? Response.json(complete) : content()
  }, options())
  expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  expect(calls).toHaveLength(2)
  expect(calls.every(call => call.authenticated)).toBe(true)
  expect(calls[0]?.url).toBe(`${baseURL}/${protocol === 'google' ? operation : 'videos/job-1'}`)
})

it('returns an already completed video response without polling', async () => {
  const response = content()
  const result = await completeVideoGeneration(response, { protocol: 'openai', baseURL }, () => { throw new Error('Unexpected GET') }, options())
  expect(result).toBe(response)
  await result.body?.cancel()
})

it('follows a signed Google delivery redirect without sending route credentials', async () => {
  const calls: Array<{ url: string; authenticated: boolean }> = []
  const result = await completeVideoGeneration(Response.json(done()), { protocol: 'google', baseURL }, async (url, authenticated) => {
    calls.push({ url: url.href, authenticated })
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://storage.googleapis.com/video.mp4?signature=fixture' } }) : content()
  }, options())
  expect(calls.map(call => call.authenticated)).toEqual([true, false])
  await result.body?.cancel()
})

it.each(['https://attacker.test/secret', 'http://storage.googleapis.com/secret', 'https://key@storage.googleapis.com/video', `${baseURL}/video#fragment`])('refuses an untrusted asset URL %s before download', async (uri) => {
  await expect(completeVideoGeneration(Response.json(done(uri)), { protocol: 'google', baseURL }, () => { throw new Error('Unexpected download') }, options())).rejects.toThrow('unsupported download URL')
})

it.each([
  { name: operation, done: true, error: { message: 'private error body' } },
  { id: 'job-1', status: 'failed' },
  { status: 'expired' },
])('stops an accepted failed job without another submission %#', async (failed) => {
  const google = 'name' in failed
  const protocol = google ? 'google' : 'id' in failed ? 'openai' : 'xai'
  const initial = google ? { name: operation } : protocol === 'openai' ? { id: 'job-1', status: 'queued' } : { request_id: 'job-1' }
  let gets = 0
  await expect(completeVideoGeneration(Response.json(initial), { protocol, baseURL }, async () => { gets++; return Response.json(failed) }, options())).rejects.toThrow('accepted job was not resubmitted')
  expect(gets).toBe(1)
})

it.each([
  [Response.json({ id: 'job-1', status: 'queued' }), { protocol: 'google' as const, baseURL }, 'invalid job identifier'],
  [Response.json({ name: operation, done: true }), { protocol: 'google' as const, baseURL }, 'completed without a video'],
  [new Response(null), { protocol: 'google' as const, baseURL }, 'no body'],
  [new Response('secret provider error', { status: 403 }), { protocol: 'google' as const, baseURL }, 'HTTP 403'],
])('rejects invalid job metadata %#', async (reply, route, message) => {
  await expect(completeVideoGeneration(reply, route, () => { throw new Error('Unexpected GET') }, options())).rejects.toThrow(message)
})

it('bounds job metadata and cancellation before another poll', async () => {
  await expect(completeVideoGeneration(Response.json({ name: operation }), { protocol: 'google', baseURL }, () => { throw new Error('Unexpected GET') }, { ...options(), maxResponseBytes: 1 })).rejects.toThrow('maxResponseBytes')
  const controller = new AbortController()
  controller.abort()
  await expect(completeVideoGeneration(Response.json({ name: operation }), { protocol: 'google', baseURL }, () => { throw new Error('Unexpected GET') }, { ...options(), signal: controller.signal })).rejects.toThrow()
})

it('refuses another job identity, missing completed assets, and failed downloads', async () => {
  const route = { protocol: 'google' as const, baseURL }
  await expect(completeVideoGeneration(Response.json({ name: operation }), route, async () => Response.json({ name: 'models/veo/operations/other' }), options())).rejects.toThrow('unexpected job')
  await expect(completeVideoGeneration(Response.json({ request_id: 'job-1' }), { protocol: 'xai', baseURL }, async () => Response.json({ status: 'done' }), options())).rejects.toThrow('completed without a video')
  await expect(completeVideoGeneration(Response.json({ request_id: 'job-1' }), { protocol: 'xai', baseURL }, async () => Response.json({ request_id: 'other', status: 'pending' }), options())).rejects.toThrow('unexpected job')
  await expect(completeVideoGeneration(Response.json(done()), route, async () => new Response(null, { status: 404 }), options())).rejects.toThrow('HTTP 404')
  await expect(completeVideoGeneration(Response.json(done()), route, async () => new Response(null, { status: 302 }), options())).rejects.toThrow('no location')
  await expect(completeVideoGeneration(Response.json(done()), route, async () => new Response(null, { status: 302, headers: { location: `${baseURL}/again` } }), options())).rejects.toThrow('redirect limit')
})
