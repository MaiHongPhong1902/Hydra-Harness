import { Context } from '@hydra/cordis'
import { SlotRegistry } from '@hydra/harness-client-runtime/client'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'
import type { ReviewInjected } from '../src/client/Review.tsx'
import type { SessionSummaryInjected } from '../src/client/SessionSummary.tsx'
import { ok } from './fixture.ts'

it('shares one source across slots and removes subscriptions on plugin and slot reload', async () => {
  applyHost()
  const ctx = new Context()
  const registry = ctx.plugin(SlotRegistry)
  await registry.await()
  const list = vi.fn(async () => ok({ changes: [] }))
  const unsubscribe = vi.fn()
  let changed: (() => void) | undefined
  const on = vi.fn((_event: string, callback: () => void) => { changed = callback; return unsubscribe })
  const hostDescription = { getSnapshot: () => undefined, subscribe: () => () => undefined }
  ctx.provide('connection', { api: { review: { list } }, hostDescription } as never)
  ctx.provide('remote', { $on: on } as never)
  const fiber = ctx.plugin({ apply, inject })
  await fiber.await()
  const declare = () => ctx.slots.register({ name: 'root', children: {
    'review': { kind: 'single', scope: 'session' },
    'tool.call.review': { kind: 'list', scope: 'session' },
    'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  let dispose = declare()
  await Promise.resolve()
  const source = (name: 'review' | 'tool.call.review') =>
    (ctx.slots.entries(name)[0]!.inject as unknown as (id: string) => ReviewInjected)('owner')
  const panel = source('review')
  expect(source('tool.call.review').hooks.review).toBe(panel.hooks.review)
  const summary = (ctx.slots.entries('conversation.session.header.utilities')[0]!.inject as unknown as
    (id: string) => SessionSummaryInjected)('owner')
  expect(summary.hooks.review).toBe(panel.hooks.review)
  expect(summary.hooks.hostDescription).toBe(hostDescription)
  await panel.refresh()
  expect(list).toHaveBeenCalledWith({ sessionId: 'owner', includeChildren: true })
  list.mockClear()
  changed!()
  await panel.refresh()
  expect(list).toHaveBeenCalled()
  list.mockClear()
  ctx.emit('connection/reset')
  await panel.refresh()
  expect(list).toHaveBeenCalled()
  dispose()
  dispose = declare()
  await Promise.resolve()
  expect(source('review').hooks.review).toBe(panel.hooks.review)
  await fiber.dispose()
  expect(ctx.slots.entries('tool.call.review')).toHaveLength(0)
  expect(unsubscribe).toHaveBeenCalledOnce()
  dispose()
  await registry.dispose()
})
