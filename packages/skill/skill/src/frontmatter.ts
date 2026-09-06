/** Shared YAML document and invocation-policy parser for file-backed skills. */
import { parse as parseYaml } from 'yaml'
import type { SkillDefinition } from './index.ts'

/** Provider-independent fields parsed from one skill document. */
export type SkillDocument = Pick<SkillDefinition, 'name' | 'description' | 'whenToUse' | 'invocation' | 'metadata' | 'content'>

/**
 * Return whether a string is a valid kebab-case skill name.
 * @param name - candidate skill name to validate.
 * @returns whether the name matches the public skill-name grammar.
 */
export function isSkillName(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
}

/**
 * Parse skill instructions and YAML metadata, including invocation controls.
 * @param raw - complete Markdown document with leading YAML frontmatter.
 * @returns validated metadata and the trimmed instruction body.
 * @throws if frontmatter, required fields, or invocation controls are invalid.
 */
export function parseSkillDocument(raw: string): SkillDocument {
  const frontmatter = /^---\r?\n([\s\S]*?\n)---(?:\r?\n|$)/.exec(raw)
  if (frontmatter === null) throw new Error('missing YAML frontmatter')
  const parsed: unknown = parseYaml(frontmatter[1] as string)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('skill frontmatter must be a YAML object')
  }
  const data = parsed as Record<string, unknown>
  if (typeof data.name !== 'string' || data.name === '' || typeof data.description !== 'string' || data.description.trim() === '') {
    throw new Error('frontmatter requires name and description')
  }
  if (!isSkillName(data.name)) throw new Error(`invalid skill name "${data.name}"`)
  for (const [legacy, canonical] of [
    ['disableModelInvocation', 'disable-model-invocation'],
    ['modelInvocable', 'disable-model-invocation'],
    ['userInvocable', 'user-invocable'],
  ] as const) {
    if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
  return {
    name: data.name,
    description: data.description,
    ...typeof data.whenToUse === 'string' && data.whenToUse !== '' ? { whenToUse: data.whenToUse } : {},
    invocation: {
      modelInvocable: frontmatterBoolean(data, 'disable-model-invocation') !== true,
      userInvocable: frontmatterBoolean(data, 'user-invocable') !== false,
    },
    ...typeof data.metadata === 'object' && data.metadata !== null && !Array.isArray(data.metadata)
      ? { metadata: data.metadata as Record<string, unknown> } : {},
    content: raw.slice(frontmatter[0].length).trim(),
  }
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}
