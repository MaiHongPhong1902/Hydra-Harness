/** Draft ownership across pending writes and section remounts. */
import { expect, it, vi } from 'vitest'
import type { RpcResponse } from '@hydra1902/harness-api-remotes/client'
import { InstructionsController } from '../src/client/instructions-store.ts'

const ok = (content: string, revision: string): RpcResponse<{ content: string; revision: string }> => ({
  rpcId: 'instructions-race' as never, result: { ok: true, value: { content, revision } },
})

it('retains newer edits after saving and submits them against the accepted revision', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof ok>>()
  const writeInstructions = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(ok('v3', '3'))
  const readInstructions = vi.fn().mockResolvedValue(ok('v1', '1'))
  const controller = new InstructionsController({ settings: { readInstructions, writeInstructions } } as never)
  await controller.ensure()
  controller.setDraft('v2')
  const saving = controller.save()
  controller.setDraft('v3')
  await controller.ensure()
  expect(readInstructions).toHaveBeenCalledTimes(1)
  pending.resolve(ok('v2', '2'))
  await saving
  expect(controller.store.getSnapshot()).toMatchObject({ draft: 'v3', savedContent: 'v2', revision: '2' })
  await controller.save()
  expect(writeInstructions).toHaveBeenLastCalledWith({ content: 'v3', expectedRevision: '2' })
  expect(controller.store.getSnapshot()).toMatchObject({ draft: 'v3', savedContent: 'v3' })
})

it('refreshes clean content on entry but preserves dirty drafts until an explicit reload', async () => {
  const readInstructions = vi.fn().mockResolvedValueOnce(ok('v1', '1')).mockResolvedValue(ok('external', '2'))
  const controller = new InstructionsController({ settings: { readInstructions } } as never)
  await controller.ensure()
  controller.setDraft('unsaved')
  await controller.ensure()
  expect(readInstructions).toHaveBeenCalledTimes(1)
  expect(controller.store.getSnapshot().draft).toBe('unsaved')
  await controller.load()
  expect(controller.store.getSnapshot().draft).toBe('external')
  await controller.ensure()
  expect(readInstructions).toHaveBeenCalledTimes(3)
})

it('shares an initial read across rapid section revisits', async () => {
  const pending = Promise.withResolvers<ReturnType<typeof ok>>()
  const readInstructions = vi.fn().mockReturnValue(pending.promise)
  const controller = new InstructionsController({ settings: { readInstructions } } as never)
  const first = controller.ensure()
  const second = controller.ensure()
  pending.resolve(ok('loaded', '1'))
  await Promise.all([first, second])
  expect(readInstructions).toHaveBeenCalledTimes(1)
  controller.dispose()
  await controller.ensure()
  expect(readInstructions).toHaveBeenCalledTimes(1)
})

it('reports a refused read and omits an unknown revision when writing', async () => {
  const readInstructions = vi.fn().mockResolvedValue({
    rpcId: 'read', result: { ok: false, error: { code: 'internal', message: 'Read refused', details: {} } },
  })
  const writeInstructions = vi.fn().mockResolvedValue(ok('replacement', '1'))
  const controller = new InstructionsController({ settings: { readInstructions, writeInstructions } } as never)
  await controller.ensure()
  expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'Read refused' })
  controller.setDraft('replacement')
  await controller.save()
  expect(writeInstructions).toHaveBeenCalledWith({ content: 'replacement' })
  expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', savedContent: 'replacement' })
})

it.each(['success', 'failure'] as const)('ignores a late save %s after the editor unloads', async (outcome) => {
  const pending = Promise.withResolvers<ReturnType<typeof ok>>()
  const controller = new InstructionsController({ settings: {
    readInstructions: () => Promise.resolve(ok('saved', '1')),
    writeInstructions: () => pending.promise,
  } } as never)
  await controller.ensure()
  controller.setDraft('submitted')
  const saving = controller.save()
  const before = controller.store.getSnapshot()
  controller.dispose()
  if (outcome === 'success') pending.resolve(ok('submitted', '2'))
  else pending.reject(new Error('Disconnected'))
  await saving
  expect(controller.store.getSnapshot()).toBe(before)
})
