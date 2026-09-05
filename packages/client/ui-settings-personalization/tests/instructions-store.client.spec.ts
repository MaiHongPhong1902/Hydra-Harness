/**
 * The custom-instructions controller: load/save over settings.readInstructions
 * / writeInstructions, with a distinct `conflict` status carrying both
 * revisions so the section can offer reload instead of a plain retry.
 */

import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@bosch/bh-api-remotes/client'
import { InstructionsController } from '../src/client/instructions-store.ts'

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

interface FakeOptions {
  content?: string
  revision?: string
  failReadWith?: Error
  writeResult?: 'ok' | 'conflict' | 'rejected'
  failWriteWith?: Error
  conflictActual?: string
}

function fakeApi(options: FakeOptions = {}): Pick<IApiClient, 'settings'> {
  const content = options.content ?? ''
  const revision = options.revision ?? EMPTY_SHA256
  return {
    settings: {
      readInstructions: () => {
        if (options.failReadWith !== undefined) return Promise.reject(options.failReadWith)
        return Promise.resolve({ rpcId: 'r', result: { ok: true as const, value: { content, revision } } })
      },
      writeInstructions: (payload: { content: string; expectedRevision?: string }) => {
        if (options.failWriteWith !== undefined) return Promise.reject(options.failWriteWith)
        if (options.writeResult === 'conflict') {
          return Promise.resolve({
            rpcId: 'r',
            result: {
              ok: false as const,
              error: {
                code: 'instructions-conflict' as const,
                message: 'stale',
                details: { expected: payload.expectedRevision ?? '', actual: options.conflictActual ?? revision },
              },
            },
          })
        }
        if (options.writeResult === 'rejected') {
          return Promise.resolve({
            rpcId: 'r',
            result: { ok: false as const, error: { code: 'instructions-rejected' as const, message: 'too big', details: {} } },
          })
        }
        return Promise.resolve({
          rpcId: 'r',
          result: { ok: true as const, value: { content: payload.content, revision: 'b'.repeat(64) } },
        })
      },
    },
  } as unknown as Pick<IApiClient, 'settings'>
}

describe('the custom-instructions controller', () => {
  it('loads the document and fills the draft from it', async () => {
    const controller = new InstructionsController(fakeApi({ content: 'be nice', revision: 'a'.repeat(64) }))

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready',
      draft: 'be nice',
      savedContent: 'be nice',
      revision: 'a'.repeat(64),
    })
  })

  it('reports a transport that rejects the read', async () => {
    const controller = new InstructionsController(fakeApi({ failReadWith: new Error('socket closed') }))

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'socket closed' })
  })

  it('tracks the draft independently of the saved content until save succeeds', async () => {
    const controller = new InstructionsController(fakeApi({ content: 'v1', revision: 'a'.repeat(64) }))
    await controller.load()

    controller.setDraft('v2')

    expect(controller.store.getSnapshot()).toMatchObject({ draft: 'v2', savedContent: 'v1' })

    await controller.save()

    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'ready', draft: 'v2', savedContent: 'v2', revision: 'b'.repeat(64),
    })
  })

  it('sends the loaded revision as expectedRevision on save', async () => {
    let sent: unknown
    const api: Pick<IApiClient, 'settings'> = {
      settings: {
        readInstructions: () => Promise.resolve({
          rpcId: 'r', result: { ok: true as const, value: { content: 'v1', revision: 'a'.repeat(64) } },
        }),
        writeInstructions: (payload: unknown) => {
          sent = payload
          return Promise.resolve({
            rpcId: 'r', result: { ok: true as const, value: { content: 'v2', revision: 'b'.repeat(64) } },
          })
        },
      },
    } as unknown as Pick<IApiClient, 'settings'>
    const controller = new InstructionsController(api)
    await controller.load()
    controller.setDraft('v2')

    await controller.save()

    expect(sent).toEqual({ content: 'v2', expectedRevision: 'a'.repeat(64) })
  })

  it('surfaces a stale write as a distinct conflict status carrying both revisions', async () => {
    const controller = new InstructionsController(fakeApi({
      content: 'v1', revision: 'a'.repeat(64), writeResult: 'conflict', conflictActual: 'c'.repeat(64),
    }))
    await controller.load()
    controller.setDraft('v2')

    await controller.save()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('conflict')
    // The conflicting draft is preserved rather than discarded, so reload is
    // the user's explicit choice, not an automatic loss of their edit.
    expect(state.draft).toBe('v2')
    expect(state.error).toBe('stale')
  })

  it('reloads from the Host to recover from a conflict', async () => {
    const controller = new InstructionsController(fakeApi({
      content: 'v1', revision: 'a'.repeat(64), writeResult: 'conflict',
    }))
    await controller.load()
    controller.setDraft('v2')
    await controller.save()
    expect(controller.store.getSnapshot().status).toBe('conflict')

    await controller.load()

    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', draft: 'v1', savedContent: 'v1' })
  })

  it('surfaces an oversized-content rejection as a generic error', async () => {
    const controller = new InstructionsController(fakeApi({ writeResult: 'rejected' }))
    await controller.load()
    controller.setDraft('x'.repeat(70_000))

    await controller.save()

    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'too big' })
  })

  it('reports a transport that rejects mid-save', async () => {
    const controller = new InstructionsController(fakeApi({ failWriteWith: new Error('socket closed') }))
    await controller.load()
    controller.setDraft('v2')

    await controller.save()

    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', error: 'socket closed' })
  })

  it('ignores a save already in flight', async () => {
    let writes = 0
    const api: Pick<IApiClient, 'settings'> = {
      settings: {
        readInstructions: () => Promise.resolve({
          rpcId: 'r', result: { ok: true as const, value: { content: '', revision: EMPTY_SHA256 } },
        }),
        writeInstructions: () => {
          writes += 1
          return Promise.resolve({
            rpcId: 'r', result: { ok: true as const, value: { content: 'v', revision: 'b'.repeat(64) } },
          })
        },
      },
    } as unknown as Pick<IApiClient, 'settings'>
    const controller = new InstructionsController(api)
    await controller.load()
    controller.setDraft('v')

    await Promise.all([controller.save(), controller.save()])

    expect(writes).toBe(1)
  })

  it('drops a late response after dispose', async () => {
    let resolveRead: (() => void) | undefined
    const api: Pick<IApiClient, 'settings'> = {
      settings: {
        readInstructions: () => new Promise((resolve) => {
          resolveRead = () => {
            resolve({
              rpcId: 'r', result: { ok: true as const, value: { content: 'late', revision: 'a'.repeat(64) } },
            })
          }
        }),
        writeInstructions: () => Promise.reject(new Error('unused')),
      },
    } as unknown as Pick<IApiClient, 'settings'>
    const controller = new InstructionsController(api)
    const pending = controller.load()

    controller.dispose()
    resolveRead?.()
    await pending

    // The disposed controller never applies the late answer over whatever a
    // remount already showed.
    expect(controller.store.getSnapshot().status).toBe('loading')
  })
})
