/**
 * subagent toolview: subagent-flavored summary row replacing the generic
 * "Tool call" card, registered into the keyed 'tool.call.toolview'
 * slot like todo-row and ask-question-row.
 */

import { IconBranchOutline16 } from '@hydraharness/harness-client-ui-primitives'
import type { Context } from '@hydraharness/cordis'
import type { PropsLocale } from '@hydraharness/harness-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

interface SubagentArgs {
  description?: string
  prompt?: string
  run_in_background?: boolean
}

function parseSubagentArgs(argsRaw: string): SubagentArgs | null {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/** Full row props: the toolview runtime share plus the standard locale seat. */
export type SubagentRowProps = ToolCallViewProps & PropsLocale<'conversation'>

/** One-line subagent delegation row (the whole row toggles the call's Input/Output sections). */
export function SubagentRow({ toolName, block, inspect, t }: SubagentRowProps) {
  const model = toolRowModel(toolName, block)
  const argsRaw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
  const parsed = parseSubagentArgs(argsRaw)
  const firstPromptLine = parsed?.prompt ? parsed.prompt.split('\n')[0] ?? '' : ''
  const description = parsed?.description || firstPromptLine || model.summary
  const isBackground = parsed?.run_in_background === true

  return (
    <ToolRow
      t={t}
      variant="code"
      toolName={toolName}
      icon={<IconBranchOutline16 size={14} />}
      title="Subagent"
      summary={description}
      summarySuffix={isBackground ? '(background)' : null}
      body={parsed?.prompt ?? model.body}
      output={model.output}
      errorSummary={model.errorSummary}
      state={model.state}
      inspect={inspect}
    />
  )
}

/**
 * The subagent row as a plain registrant plugin following the atomic Tool-view
 * declaration across independent activation and reload lifetimes.
 */
export const subagentToolview = {
  name: 'subagent-toolview',
  inject: ['slots'],
  /**
   * Register the subagent row into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key: 'subagent', locale: NS }, SubagentRow))
  },
}
