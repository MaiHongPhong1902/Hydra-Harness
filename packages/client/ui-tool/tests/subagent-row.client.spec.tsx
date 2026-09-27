// @vitest-environment jsdom
/** subagent atomic Tool presentation. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunningToolCall, ToolResultNode } from '@hydra1902/harness-client-runtime/client'
import { makeTranslate } from '@hydra1902/harness-client-test-runtime'
import { en as commonEn } from '@hydra1902/harness-client-locale/src/locales/en.ts'
import { SubagentRow, subagentToolview } from '../src/client/tool/toolviews/subagent-row.tsx'
import { CONVERSATION_NS as NS } from '../src/client/locale.ts'
import { en } from '@hydra1902/harness-client-ui-conversation/src/client/locales.ts'

type SubagentRowProps = Parameters<typeof SubagentRow>[0]

const t: SubagentRowProps['t'] = makeTranslate(en, commonEn)

afterEach(cleanup)

const resultNode = (argsRaw: string, over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callTime: 1_000, callId: 'c1',
  call: { name: 'subagent', argsRaw },
  content: [{ type: 'text', text: 'Subagent completed successfully' }],
  isError: false, callView: null, resultView: null, subCalls: [], ...over,
})

const runningNode = (argsRaw: string, over?: Partial<RunningToolCall>): RunningToolCall => ({
  callId: 'c1', name: 'subagent', argsRaw,
  turn: 1, step: 1, time: 1_000, callView: null, subCalls: [], ...over,
})

function rowProps(block: unknown, over?: Partial<SubagentRowProps>): SubagentRowProps {
  return {
    callId: 'c1', toolName: 'subagent', block,
    openFile: vi.fn(),
    inspect: vi.fn(),
    sessionId: 's1',
    useSessions: () => undefined,
    t,
    ...over,
  } as unknown as SubagentRowProps
}

describe('SubagentRow', () => {
  const ARGS = JSON.stringify({
    description: 'Explore codebase structure',
    prompt: 'Read packages and summarize dependencies',
  })

  it('renders title Subagent and extracts description as summary', () => {
    render(<SubagentRow {...rowProps(resultNode(ARGS))} />)
    expect(screen.getByText('Subagent')).toBeTruthy()
    expect(screen.getByText('Explore codebase structure')).toBeTruthy()
  })

  it('shows (background) suffix when run_in_background is true', () => {
    const bgArgs = JSON.stringify({
      description: 'Long running task',
      prompt: 'Do deep analysis',
      run_in_background: true,
    })
    render(<SubagentRow {...rowProps(resultNode(bgArgs))} />)
    expect(screen.getByText('Long running task')).toBeTruthy()
    expect(screen.getByText('(background)')).toBeTruthy()
  })

  it('renders running state with running status dot', () => {
    const view = render(<SubagentRow {...rowProps(runningNode(ARGS))} />)
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()
  })

  it('renders stopped state on interrupted error', () => {
    const view = render(
      <SubagentRow {...rowProps(resultNode(ARGS, { isError: true, error: { name: 'Interrupted', code: 'interrupted' } }))} />,
    )
    expect(view.container.querySelector('[data-state="stopped"]')).not.toBeNull()
  })

  it('expands to show clean prompt in body rather than raw JSON', () => {
    render(<SubagentRow {...rowProps(resultNode(ARGS))} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('Read packages and summarize dependencies')).toBeTruthy()
    // Does not show raw JSON braces in the body
    expect(screen.queryByText('{"description"')).toBeNull()
  })

  it('passes the owner inspect callback through to the expanded row pill', () => {
    const inspect = vi.fn()
    render(<SubagentRow {...rowProps(resultNode(ARGS), { inspect })} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    fireEvent.click(screen.getByText('Inspect'))
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('falls back to raw summary on non-JSON args', () => {
    render(<SubagentRow {...rowProps(resultNode('not-json'))} />)
    expect(screen.getByText('Subagent')).toBeTruthy()
    expect(screen.getByText('not-json')).toBeTruthy()
  })

  it('injects the keyed toolview declaration directly', () => {
    expect(subagentToolview.name).toBe('subagent-toolview')
    expect(subagentToolview.inject).toEqual(['slots'])
    const register = vi.fn(() => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    subagentToolview.apply({ slots: { inject, register } } as never)
    expect(inject).toHaveBeenCalledWith('tool.call.toolview', expect.any(Function))
    expect(register).toHaveBeenCalledWith({ name: 'tool.call.toolview', key: 'subagent', locale: NS }, SubagentRow)
  })
})
