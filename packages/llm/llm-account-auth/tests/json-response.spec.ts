/** Native JSON rejection and cancellation retain reader ownership without exposing provider bodies. */
import { expect, it, vi } from 'vitest'
import { accountJson } from '../src/json-response.ts'

it.each([null, '', 'not-json-secret', 'null', '[]', 'false', '1', '"secret"'])('rejects an empty or non-object JSON body %s', async (body) => {
  await expect(accountJson(new Response(body), new AbortController().signal)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
})

it('aborts an outstanding read even when the provider rejects cancellation', async () => {
  const controller = new AbortController()
  const canceled = vi.fn(async () => { throw new Error('already disconnected') })
  const response = new Response(new ReadableStream<Uint8Array>({ cancel: canceled }))
  const operation = accountJson(response, controller.signal)
  controller.abort(new Error('canceled read'))
  await expect(operation).rejects.toThrow('canceled read')
  expect(canceled).toHaveBeenCalledOnce()
})

it('preserves a body read failure when cleanup also encounters the errored stream', async () => {
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('lost body')) } }))
  await expect(accountJson(response, new AbortController().signal)).rejects.toThrow('lost body')
})
