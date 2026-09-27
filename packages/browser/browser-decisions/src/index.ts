/** Advisory model-facing decisions over candidate browser actions. */

import type { Context } from '@hydra1902/cordis'
import { defineTool } from '@hydra1902/harness-tools'
import type { ToolExecution } from '@hydra1902/harness-tools'
import { JevError } from '@hydra1902/harness-jev'

export const name = 'browser-decisions'
export const inject = ['tools']

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      available: { type: 'boolean', required: true },
      decision: { type: 'string' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
  } as const,
  render: (_args: unknown, value: DecisionOutput) => [{
    type: 'text' as const,
    text: value.available
      ? `Jev chose ${value.decision ?? 'no action'}${value.confidence === undefined ? '' : ` (${Math.round(value.confidence * 100)}% confidence)`}.`
      : `Jev decision unavailable: ${value.reason ?? 'provider not configured'}`,
  }],
}

interface DecisionOutput {
  readonly available: boolean
  readonly decision?: string
  readonly confidence?: number
  readonly reason?: string
}

interface DecisionArgs {
  readonly state: string
  readonly question: string
  readonly choices: string[]
}

/** Register a tool that can abstain without changing browser execution. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'browser_decide',
    description: 'Ask the optional Jev decision provider to choose one candidate action from the current browser state. This tool only returns advice; it never navigates, clicks, or changes permissions.',
    parameters: {
      state: { type: 'string', required: true, description: 'Observed browser state relevant to the choice.' },
      question: { type: 'string', required: true, description: 'The decision to make.' },
      choices: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: OUTPUT,
    async execute(args: DecisionArgs, exec: ToolExecution): Promise<DecisionOutput> {
      if (args.state.trim() === '' || args.question.trim() === '' || args.choices.some(choice => choice.trim() === '')
        || args.choices.length < 2 || new Set(args.choices).size !== args.choices.length) {
        return { available: false, reason: 'Provide at least two distinct candidate choices.' }
      }
      const jev = ctx.get('jev')
      if (jev === undefined) return { available: false, reason: 'Jev provider is disabled or unavailable.' }
      try {
        const criteria = Object.fromEntries(args.choices.map(choice => [choice, choice]))
        const result = await jev.systemOne({
          state: args.state,
          questions: { decision: { type: 'choice', instructions: args.question, criteria } },
        }, { signal: exec.signal })
        const answer = result.answers.decision
        if (answer === undefined || answer.type !== 'choice' || typeof answer.choice !== 'string'
          || !args.choices.includes(answer.choice) || typeof answer.confidence !== 'number'
          || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
          return { available: false, reason: 'Jev returned no candidate choice.' }
        }
        return {
          available: true,
          decision: answer.choice,
          confidence: answer.confidence,
        }
      } catch (error) {
        return { available: false, reason: error instanceof JevError ? `Jev unavailable (${error.code}). Continue with the existing browser tools.` : 'Jev request failed. Continue with the existing browser tools.' }
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Ask Jev for a browser decision', kind: 'other' }),
  }))
}
