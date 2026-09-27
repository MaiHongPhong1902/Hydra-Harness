import type { Context } from '@hydra1902/cordis'
import type { SessionId, UserMessageNode } from '@hydra1902/harness-client-runtime/client'
import { NS } from '../locales.ts'
import { AssistantNodeView } from './AssistantNodeView.tsx'
import { CommandNodeView, ManualCompactionNodeView } from './CommandNodeView.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView, UserMessageNodeView,
} from './MessageItem.tsx'
import { TurnTailNodeView } from './TurnTailNodeView.tsx'
import type { PromptEditOptions } from '../contract/prompt-edit.ts'

/**
 * Register this package's business renderers behind the keyed Chat Node seat.
 * @param ctx - owning UI Conversation context.
 * @param editMessage - replaces a turn with a new prompt revision and response.
 * @param retryRevision - retries the current failed attempt, keeping its user revision identity.
 */
export function registerChatNodeRenderers(
  ctx: Context,
  editMessage: (sessionId: SessionId, node: UserMessageNode, text: string, options: PromptEditOptions) => Promise<void>,
  retryRevision: (sessionId: SessionId, idempotencyKey: string) => Promise<void>,
): void {
  for (const key of ['user', 'steering'] as const) {
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
      { name: 'conversation.chat.node', key, locale: NS,
        inject: (sessionId: SessionId) => ({
          editMessage: (node: UserMessageNode, text: string, options: PromptEditOptions) => editMessage(sessionId, node, text, options),
          openVersion: (id: SessionId) => { ctx.sessions.open(id) },
        }),
      }, UserMessageNodeView))
  }
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'context', locale: NS }, ContextMessageNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'assistant-step', locale: NS }, AssistantNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'command',
    locale: NS,
    children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } },
  }, CommandNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'manual-compaction', locale: NS }, ManualCompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'compaction', locale: NS }, CompactionNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'model-retry', locale: NS }, RetryNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-error', locale: NS }, TurnErrorNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'turn-max-tokens', locale: NS }, TurnMaxTokensNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'turn-tail',
    locale: NS,
    inject: (sessionId: SessionId) => ({ retryRevision: (key: string) => retryRevision(sessionId, key) }),
    children: {
      'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    },
  }, TurnTailNodeView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'unknown', locale: NS }, UnknownNodeView))
}
