/**
 * Model-facing Consumer of the `ctx.userQuestions` capability seam.
 * The tool pauses until a UI provider returns a human answer, then feeds that
 * answer back into the agent loop as an ordinary tool result.
 *
 * @module @hydra/harness-tool-ask-user
 */

import type { Context } from '@hydra/cordis'
import type { Agent } from '@hydra/harness-agent'
import { defineTool } from '@hydra/harness-tools'
import '@hydra/harness-user-questions'

export const name = 'tool-ask-user'
export const inject = ['tools', 'userQuestions']

const description = 'Ask the user a concise question only when confirmation, a genuine user-owned choice, or a material fact unavailable through normal inspection blocks a concrete task. '
  + 'Do not use this for greetings, acknowledgements, casual chat, vague requests, or generic action, task, or tool menus. '
  + 'When the request clearly implies an available tool or execution path, inspect the context, choose it yourself, and proceed; do not ask the user to choose between tools or implementation options. '
  + 'Send one or more questions, each with a stable id that will be echoed in the answer.'

const GENERIC_IMPROVEMENT_LABELS = new Set([
  'performance', 'features', 'reliability', 'safety', 'security', 'latency',
  'quality', 'ux', 'user experience', 'explainability', 'scalability',
  'hiệu suất', 'tính năng', 'độ tin cậy', 'an toàn', 'bảo mật', 'độ trễ',
  'chất lượng', 'trải nghiệm người dùng', 'khả năng giải thích', 'khả năng mở rộng',
])

function latestDirectUserText(agent: Agent | undefined): string | undefined {
  const events = agent?.session.events
  if (events === undefined) return
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message' || event.data.source.kind !== 'user') continue
    return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }
}

function isGenericImprovementMenu(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const questions = (value as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return false
  return questions.some((question) => {
    if (question === null || typeof question !== 'object') return false
    const questionText = (question as { question?: unknown }).question
    const options = (question as { options?: unknown }).options
    const labels = Array.isArray(options) ? options.flatMap((option) => {
      if (option === null || typeof option !== 'object') return []
      const label = (option as { label?: unknown }).label
      return typeof label === 'string' ? [label.trim().toLowerCase()] : []
    }) : []
    // Narrow phrase check; add an intent classifier only for reproduced evasions.
    const menuText = [typeof questionText === 'string' ? questionText : '', ...labels].join('\n').toLowerCase()
    return [...GENERIC_IMPROVEMENT_LABELS].filter(label => menuText.includes(label)).length >= 3
  })
}

function genericImprovementMenuReason(agent: Agent | undefined, args: unknown): string | undefined {
  const userText = latestDirectUserText(agent)
  if (userText === undefined
    || !/(?:\bimprov(?:e|ing|ement)\b|\benhanc(?:e|ing|ement)\b|\boptimi[sz](?:e|ing|ation)\b|cải thiện|nâng cấp|tối ưu)/iu.test(userText)
    || !isGenericImprovementMenu(args)) return
  return 'ask_user_question cannot offer a generic improvement-category menu. Inspect the available context and take the smallest safe useful step; ask only for a material fact normal inspection cannot establish or a genuinely user-owned choice.'
}

export function apply(ctx: Context): void {
  ctx.tools.guard(exec => exec.name === 'ask_user_question'
    ? genericImprovementMenuReason(exec.agent, exec.arguments)
    : undefined)
  ctx.tools.register(defineTool({
    name: 'ask_user_question',
    description,
    parameters: {
      questions: {
        type: 'array',
        required: true,
        description: 'Questions to ask the user before continuing.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
            question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
            header: {
              type: 'string',
              description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
            },
            options: {
              type: 'array',
              description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true, description: 'Short user-facing option label.' },
                  description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
                },
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Whether the user may select more than one option. Defaults to false.',
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const result = await ctx.userQuestions.ask({
        questions: args.questions.map(question => ({
          id: question.id,
          question: question.question,
          ...question.header !== undefined ? { header: question.header } : {},
          ...question.options !== undefined ? { options: question.options } : {},
          ...question.multi_select !== undefined ? { multiSelect: question.multi_select } : {},
        })),
        ...exec.agent !== undefined ? { agent: exec.agent } : {},
        signal: exec.signal,
      })
      return {
        answers: result.answers.map(answer => ({
          id: answer.id,
          selected: [...answer.selected],
          ...answer.custom !== undefined ? { custom: answer.custom } : {},
        })),
      }
    },
  }))
}
