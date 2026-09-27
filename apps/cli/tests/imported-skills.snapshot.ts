import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@hydra1902/harness-loader-smoke'

const binScript = fileURLToPath(new URL('./fixtures/imported-skills/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/imported-skills/cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('imported skill assembled snapshot', () => {
  it('searches one definition, enforces policy, and logs only permitted skill invocations', async () => {
    const result = await runLoaderSmoke({
      label: 'imported skill snapshot', tempDirPrefix: 'imported-skill-snapshot-',
      binScript, libBinScript: binScript, configPath, tsconfigPath, processTimeoutMs: 75_000,
      async prepare(cwd) {
        const root = join(cwd, 'plugin')
        await mkdir(join(root, '.codex-plugin'), { recursive: true })
        await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'skill-fixture', version: '1.0.0', skills: './skills/' }))
        for (const [name, fields, body] of [
          ['obsidian-uat-test-design', 'description: >\n  Zebra reconciliation\n  instructions.', 'Follow the reconciliation checklist.'],
          ['user-only', 'description: Manual checklist\ndisable-model-invocation: true', 'Follow the manual checklist.'],
          ['model-only', 'description: Model checklist\nuser-invocable: false', 'Follow the model checklist.'],
        ] as const) {
          const dir = join(root, 'skills', name)
          await mkdir(dir, { recursive: true })
          await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\n${fields}\n---\n${body}\n`)
        }
      },
    })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
      {
        "denied": {
          "isError": true,
          "text": "Error: skill "user-only" is not available for model invocation",
        },
        "disabled": {
          "isError": false,
          "text": "<skill_candidates complete="true" truncated="false">
      (none)
      </skill_candidates>
      Choose zero or one candidate. Call \`skill\` only for the best match; load another only when the task clearly requires an independent skill.",
        },
        "loaded": {
          "isError": false,
          "text": "<skill_content name="obsidian-uat-test-design">
      <skill_resources>
      Base directory for this skill: {{skills}}/obsidian-uat-test-design
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      Follow the reconciliation checklist.
      </skill_instructions>
      </skill_content>",
        },
        "search": {
          "isError": false,
          "text": "<skill_candidates complete="true" truncated="false">
      - \`obsidian-uat-test-design\`: Zebra reconciliation instructions.
      </skill_candidates>
      Choose zero or one candidate. Call \`skill\` only for the best match; load another only when the task clearly requires an independent skill.",
        },
        "turns": [
          {
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "test obsidian",
              },
              {
                "source": {
                  "form": "instructions",
                  "kind": "skill-invocation",
                  "name": "obsidian-uat-test-design",
                  "trigger": "automatic",
                },
                "text": "<skill_content name="obsidian-uat-test-design">
      <skill_resources>
      Base directory for this skill: {{skills}}/obsidian-uat-test-design
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      Follow the reconciliation checklist.
      </skill_instructions>
      </skill_content>",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "test obsidian",
              },
              {
                "source": {
                  "form": "instructions",
                  "kind": "skill-invocation",
                  "name": "obsidian-uat-test-design",
                  "trigger": "automatic",
                },
                "text": "<skill_content name="obsidian-uat-test-design">
      <skill_resources>
      Base directory for this skill: {{skills}}/obsidian-uat-test-design
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      Follow the reconciliation checklist.
      </skill_instructions>
      </skill_content>",
              },
            ],
          },
          {
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Do not use obsidian-uat-test-design; explain what it does.",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Do not use obsidian-uat-test-design; explain what it does.",
              },
            ],
          },
          {
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Đừng dùng obsidian-uat-test-design.",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Đừng dùng obsidian-uat-test-design.",
              },
            ],
          },
          {
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "/user-only",
              },
              {
                "source": {
                  "form": "instructions",
                  "kind": "skill-invocation",
                  "name": "user-only",
                  "trigger": "user",
                },
                "text": "<skill_content name="user-only">
      <skill_resources>
      Base directory for this skill: {{skills}}/user-only
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      Follow the manual checklist.
      </skill_instructions>
      </skill_content>",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "/user-only",
              },
              {
                "source": {
                  "form": "instructions",
                  "kind": "skill-invocation",
                  "name": "user-only",
                  "trigger": "user",
                },
                "text": "<skill_content name="user-only">
      <skill_resources>
      Base directory for this skill: {{skills}}/user-only
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      Follow the manual checklist.
      </skill_instructions>
      </skill_content>",
              },
            ],
          },
          {
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "/model-only",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "/model-only",
              },
            ],
          },
        ],
      }
    `)
  }, 90_000)
})
