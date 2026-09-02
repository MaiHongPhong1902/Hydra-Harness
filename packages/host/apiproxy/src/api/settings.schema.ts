/**
 * settings domain zod schemas (names derived from map keys: settingsDescribeRequestSchema /
 * settingsDescribeValueSchema / settingsUpdate* / settingsReplace*).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { InstructionsDocumentView, MemoryEntryView, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView } from './settings.ts'

/** A SHA-256 hex digest (lowercase, 64 characters), as used by InstructionsDocumentView.revision. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/)

/** One redacted secret slot. */
export const settingsSecretViewSchema = z.object({
  path: z.array(z.string()),
  set: z.boolean(),
}) satisfies z.ZodType<Wire<SettingsSecretView>>

/** SettingsNamespaceView row of settings.describe and the write responses. */
export const settingsNamespaceViewSchema = z.object({
  ns: z.string().min(1),
  schema: z.unknown(),
  value: z.unknown(),
  base: z.unknown().optional(),
  user: z.unknown().optional(),
  applies: z.union([z.literal('live'), z.literal('restart')]),
  secrets: z.array(settingsSecretViewSchema),
  revision: z.number(),
}) satisfies z.ZodType<Wire<SettingsNamespaceView>>

/** settings.describe request payload. */
export const settingsDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'settings.describe'>>>

/** settings.describe response value. */
export const settingsDescribeValueSchema = z.object({
  writable: z.boolean(),
  hasDocument: z.boolean(),
  namespaces: z.array(settingsNamespaceViewSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'settings.describe'>>>

/** settings.openDocument request payload. */
export const settingsOpenDocumentRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'settings.openDocument'>>>

/** settings.openDocument response value. */
export const settingsOpenDocumentValueSchema = z.object({
  opened: z.literal(true),
}) satisfies z.ZodType<Wire<ResponseValue<'settings.openDocument'>>>

/** settings.update request payload. */
export const settingsUpdateRequestSchema = z.object({
  ns: z.string().min(1),
  patch: z.record(z.string(), z.unknown()),
  expectedRevision: z.number().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'settings.update'>>>

/** settings.update response value: the namespace's new redacted view. */
export const settingsUpdateValueSchema = settingsNamespaceViewSchema satisfies z.ZodType<Wire<ResponseValue<'settings.update'>>>

/** settings.replace request payload. */
export const settingsReplaceRequestSchema = z.object({
  ns: z.string().min(1),
  section: z.record(z.string(), z.unknown()),
  expectedRevision: z.number().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'settings.replace'>>>

/** One path-addressed edit of settings.mutate. */
export const settingsPathOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: z.array(z.string()), value: z.unknown() }),
  z.object({ op: z.literal('unset'), path: z.array(z.string()) }),
]) as unknown as z.ZodType<Wire<SettingsPathOpView>>

/** settings.mutate request payload. */
export const settingsMutateRequestSchema = z.object({
  ns: z.string().min(1),
  ops: z.array(settingsPathOpSchema),
  expectedRevision: z.number().optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'settings.mutate'>>>

/** settings.mutate response value: the namespace's new redacted view. */
export const settingsMutateValueSchema = settingsNamespaceViewSchema satisfies z.ZodType<Wire<ResponseValue<'settings.mutate'>>>

/** settings.replace response value. */
export const settingsReplaceValueSchema = settingsNamespaceViewSchema satisfies z.ZodType<Wire<ResponseValue<'settings.replace'>>>

/** InstructionsDocumentView of settings.readInstructions and settings.writeInstructions. */
export const instructionsDocumentViewSchema = z.object({
  content: z.string(),
  revision: sha256HexSchema,
}) satisfies z.ZodType<Wire<InstructionsDocumentView>>

/** settings.readInstructions request payload. */
export const settingsReadInstructionsRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'settings.readInstructions'>>>

/** settings.readInstructions response value. */
export const settingsReadInstructionsValueSchema = instructionsDocumentViewSchema satisfies z.ZodType<Wire<ResponseValue<'settings.readInstructions'>>>

/** settings.writeInstructions request payload. */
export const settingsWriteInstructionsRequestSchema = z.object({
  content: z.string(),
  expectedRevision: sha256HexSchema.optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'settings.writeInstructions'>>>

/** settings.writeInstructions response value. */
export const settingsWriteInstructionsValueSchema = instructionsDocumentViewSchema satisfies z.ZodType<Wire<ResponseValue<'settings.writeInstructions'>>>

/** One persisted memory entry. */
export const memoryEntryViewSchema = z.object({
  id: z.uuid(), text: z.string(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<MemoryEntryView>>
/** settings.listMemories request payload. */
export const settingsListMemoriesRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'settings.listMemories'>>>
/** settings.listMemories response value. */
export const settingsListMemoriesValueSchema = z.object({ entries: z.array(memoryEntryViewSchema) }) satisfies z.ZodType<Wire<ResponseValue<'settings.listMemories'>>>
/** settings.removeMemory request payload. */
export const settingsRemoveMemoryRequestSchema = z.object({ id: z.uuid() }) satisfies z.ZodType<Wire<RequestPayload<'settings.removeMemory'>>>
/** settings.removeMemory response value. */
export const settingsRemoveMemoryValueSchema = z.object({ removed: z.boolean() }) satisfies z.ZodType<Wire<ResponseValue<'settings.removeMemory'>>>
