import { describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({})),
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { spawnDialogWorker } from '../src/win32-dialog-host.ts'

const originalElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron')

describe('spawnDialogWorker', () => {
  it('runs the worker as Node when the host is Electron', () => {
    Object.defineProperty(process.versions, 'electron', { configurable: true, value: '43.4.1' })
    try {
      spawnDialogWorker({ title: 'Select Workspace Directory' })
      expect(spawnMock).toHaveBeenCalledOnce()
      const [, , options] = spawnMock.mock.calls[0] as unknown as [string, string[], { env?: NodeJS.ProcessEnv }]
      expect(options).toMatchObject({
        env: expect.objectContaining({
          BH_DIALOG_TITLE: 'Select Workspace Directory',
          ELECTRON_RUN_AS_NODE: '1',
        }),
      })
    } finally {
      if (originalElectron === undefined) Reflect.deleteProperty(process.versions, 'electron')
      else Object.defineProperty(process.versions, 'electron', originalElectron)
      spawnMock.mockReset()
    }
  })
})
