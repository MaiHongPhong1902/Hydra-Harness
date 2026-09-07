import { expect, it } from 'vitest'
import { LlmError } from '../src/index.ts'
import { streamWithApiKeys, withApiKeyAttempt } from '../src/api-key-fallback.ts'
import type { GenerateOptions, StreamChunk } from '../src/types.ts'

const request: GenerateOptions = { provider: 'test', model: 'test', messages: [] }
const text: StreamChunk = { type: 'text-delta', index: 0, text: 'done' }
const stop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const failed: StreamChunk = { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'refused' } } }
const aborted: StreamChunk = { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stopped' } } }

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

it('discards buffered partial output and exposes only the successful fallback', async () => {
  const tried: number[] = []
  const chunks = await collect(streamWithApiKeys(request, 3, async function* (index) {
    tried.push(index)
    yield text
    if (index === 0) throw new LlmError('transport', 'TRANSPORT')
    yield index === 1 ? failed : stop
  }))
  expect(tried).toEqual([0, 1, 2])
  expect(chunks).toEqual([text, stop])
})

it('returns the last error finish when all keys fail', async () => {
  expect(await collect(streamWithApiKeys(request, 2, async function* () { yield failed }))).toEqual([failed])
})

it.each([undefined, 'ABORTED'])('preserves a terminal throw without trying another key: %s', async (code) => {
  const tried: number[] = []
  const error = new LlmError('last failure', code ?? 'AUTH')
  await expect(collect(streamWithApiKeys(request, 2, async function* (index) {
    tried.push(index)
    throw error
  }))).rejects.toBe(error)
  expect(tried).toEqual(code === 'ABORTED' ? [0] : [0, 1])
})

it('keeps single-key requests streaming before completion', async () => {
  const iterator = streamWithApiKeys(request, 1, async function* () { yield text; yield stop })
  expect(await iterator.next()).toEqual({ done: false, value: text })
  expect(await collect(iterator)).toEqual([stop])
})

it('lets agent recovery own one streamed attempt and clamps removed key positions', async () => {
  const attempt = { index: 4, count: 0 }
  const tried: number[] = []
  const iterator = streamWithApiKeys(request, 2, async function* (index) { tried.push(index); yield text; yield failed })
  expect(await withApiKeyAttempt(attempt, () => iterator.next())).toEqual({ done: false, value: text })
  expect(attempt).toEqual({ index: 1, count: 2 })
  expect(await withApiKeyAttempt(attempt, () => collect(iterator))).toEqual([failed])
  expect(tried).toEqual([1])
})

it('does not retry an aborted finish', async () => {
  let calls = 0
  expect(await collect(streamWithApiKeys(request, 2, async function* () { calls++; yield aborted }))).toEqual([aborted])
  expect(calls).toBe(1)
})

it('does not dispatch after cancellation and stops a buffered attempt when canceled', async () => {
  const controller = new AbortController()
  const canceled = { ...request, signal: controller.signal }
  const reason = new Error('stop')
  let calls = 0
  const stream = () => streamWithApiKeys(canceled, 2, async function* () {
    calls++
    controller.abort(reason)
    yield text
  })
  await expect(collect(stream())).rejects.toBe(reason)
  expect(calls).toBe(1)
  expect(await collect(stream())).toMatchObject([{ type: 'finish', reason: { kind: 'aborted' } }])
  expect(calls).toBe(1)
})

it('does not treat consumer errors as provider failures', async () => {
  let calls = 0
  const stream = streamWithApiKeys(request, 2, async function* () { calls++; yield text; yield stop })
  await stream.next()
  const consumerError = new Error('consumer failed')
  await expect(stream.throw(consumerError)).rejects.toBe(consumerError)
  expect(calls).toBe(1)
})
