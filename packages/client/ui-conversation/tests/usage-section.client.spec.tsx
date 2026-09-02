// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@bosch/bh-client-test-runtime'
import { createSnapshotStore, type SessionId, type SessionListState } from '@bosch/bh-client-runtime/client'
import { UsageSection } from '../src/client/settings/UsageSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (id: string): SessionId => id as SessionId

describe('UsageSection', () => {
  it('sums input and output across sessions and keeps models separate', () => {
    const a = sid('usage-a')
    const b = sid('usage-b')
    const list = createSnapshotStore<SessionListState>({
      ids: [a, b],
      byId: {
        [a]: {
          id: a, displayTitle: a, running: false, blank: false, updatedAt: 1,
          projectionValues: {
            modelTokenUsage: [{
              provider: 'bosch', model: 'model-a', uncachedInputTokens: 1_000,
              cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 40,
            }],
          },
        },
        [b]: {
          id: b, displayTitle: b, running: false, blank: false, updatedAt: 2,
          projectionValues: {
            modelTokenUsage: [
              {
                provider: 'bosch', model: 'model-a', uncachedInputTokens: 100,
                cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10,
              },
              {
                provider: 'bosch', model: 'model-b', uncachedInputTokens: 20,
                cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 400,
              },
            ],
          },
        },
      },
      current: a,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    })
    const unusedHook = (() => { throw new Error('unused') }) as never
    render(<UsageSection
      close={() => {}}
      useSessions={bindSnapshotSelector(list)}
      useWorkspaces={unusedHook}
      t={makeTranslate(en)}
    />)

    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(within(rows[1]!).getByText('model-a')).toBeDefined()
    expect(within(rows[1]!).getByText('1,600')).toBeDefined()
    expect(within(rows[1]!).getByText('50')).toBeDefined()
    expect(within(rows[2]!).getByText('model-b')).toBeDefined()
    expect(within(rows[2]!).getByText('20')).toBeDefined()
    expect(within(rows[2]!).getByText('400')).toBeDefined()
  })
})
