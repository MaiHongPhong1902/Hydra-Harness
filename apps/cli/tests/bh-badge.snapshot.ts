import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@bosch/bh-loader-smoke'
const binScript = fileURLToPath(new URL('./fixtures/bh-badge/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/bh-badge/cordis.yml', import.meta.url))
const defaultConfigPath = fileURLToPath(new URL('./fixtures/bh-badge/default.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const badgeAssetsPath = fileURLToPath(new URL('../../../packages/skill/skill-badge/assets/', import.meta.url))

describe('bh badge assembled snapshot', () => {
  it('searches and loads the opt-in bundled skill through the shipped app', async () => {
    const disabled = await runLoaderSmoke({
      label: 'disabled bh badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-bh-badge-disabled-',
      binScript,
      libBinScript: binScript,
      configPath: defaultConfigPath,
      tsconfigPath,
      processTimeoutMs: 75_000,
    })
    const enabled = await runLoaderSmoke({
      label: 'bh badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-bh-badge-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
      processTimeoutMs: 75_000,
    })
    const disabledSnapshot = JSON.parse(disabled.stdout) as unknown
    const enabledSnapshot = JSON.parse(
      enabled.stdout.replaceAll(JSON.stringify(badgeAssetsPath).slice(1, -1), '{{badgeAssetsPath}}'),
    ) as unknown

    expect(disabled.stderr).toBe('')
    expect(enabled.stderr).toBe('')
    expect(disabledSnapshot).toMatchInlineSnapshot(`
      {
        "result": {
          "content": [
            {
              "text": "Error: skill "bh-badge" is unknown or no longer available",
              "type": "text",
            },
          ],
          "error": {
            "message": "skill "bh-badge" is unknown or no longer available",
          },
          "isError": true,
        },
        "search": {
          "content": [
            {
              "text": "<skill_candidates complete="true" truncated="false">
      (none)
      </skill_candidates>
      Choose zero or one candidate. Call \`skill\` only for the best match; load another only when the task clearly requires an independent skill.",
              "type": "text",
            },
          ],
          "isError": false,
          "value": {
            "complete": true,
            "matches": [],
            "truncated": false,
          },
        },
        "summary": null,
      }
    `)
    expect(enabledSnapshot).toMatchInlineSnapshot(`
      {
        "result": {
          "content": [
            {
              "text": "<skill_content name="bh-badge">
      <skill_resources>
      Base directory for this skill: {{badgeAssetsPath}}
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      # bh Badge

      Add the official “powered by bh” badge without recreating or restyling it.

      ## Assets

      - Local PNG: [\`bh-badge.png\`](bh-badge.png), 726×120 source image; render at 121×20
      - Shields.io image URL: \`https://img.shields.io/badge/powered_by-bh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white\`
      - Project URL: \`https://github.com/bosch/bosch-harness\`

      ## Markdown

      Use this linked badge in Markdown:

      \`\`\`markdown
      [![](https://img.shields.io/badge/powered_by-bh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/bosch/bosch-harness)
      \`\`\`

      If attribution should not be linked, use:

      \`\`\`markdown
      ![](https://img.shields.io/badge/powered_by-bh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)
      \`\`\`

      ## Usage rules

      - For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
      - For Feishu and other systems that import remote images unreliably, upload \`bh-badge.png\` from this skill directory instead of generating another badge.
      - Preserve the badge's 121×20 dimensions and aspect ratio.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Do not substitute another color, logo, label, or project URL.

      </skill_instructions>
      </skill_content>",
              "type": "text",
            },
          ],
          "isError": false,
          "value": {
            "content": "# bh Badge

      Add the official “powered by bh” badge without recreating or restyling it.

      ## Assets

      - Local PNG: [\`bh-badge.png\`](bh-badge.png), 726×120 source image; render at 121×20
      - Shields.io image URL: \`https://img.shields.io/badge/powered_by-bh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white\`
      - Project URL: \`https://github.com/bosch/bosch-harness\`

      ## Markdown

      Use this linked badge in Markdown:

      \`\`\`markdown
      [![](https://img.shields.io/badge/powered_by-bh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/bosch/bosch-harness)
      \`\`\`

      If attribution should not be linked, use:

      \`\`\`markdown
      ![](https://img.shields.io/badge/powered_by-bh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)
      \`\`\`

      ## Usage rules

      - For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
      - For Feishu and other systems that import remote images unreliably, upload \`bh-badge.png\` from this skill directory instead of generating another badge.
      - Preserve the badge's 121×20 dimensions and aspect ratio.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Do not substitute another color, logo, label, or project URL.
      ",
            "name": "bh-badge",
            "provider": "bh-badge",
            "resourceBase": {
              "kind": "directory",
              "path": "{{badgeAssetsPath}}",
            },
          },
        },
        "search": {
          "content": [
            {
              "text": "<skill_candidates complete="true" truncated="false">
      - \`bh-badge\`: Add the official “powered by bh” badge to documents, pull requests, merge requests, and other content produced with Bosch Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a bh badge, powered-by-bh attribution, or a reusable bh badge asset or snippet.
      </skill_candidates>
      Choose zero or one candidate. Call \`skill\` only for the best match; load another only when the task clearly requires an independent skill.",
              "type": "text",
            },
          ],
          "isError": false,
          "value": {
            "complete": true,
            "matches": [
              {
                "description": "Add the official “powered by bh” badge to documents, pull requests, merge requests, and other content produced with Bosch Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a bh badge, powered-by-bh attribution, or a reusable bh badge asset or snippet.",
                "name": "bh-badge",
              },
            ],
            "truncated": false,
          },
        },
        "summary": {
          "description": "Add the official “powered by bh” badge to documents, pull requests, merge requests, and other content produced with Bosch Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a bh badge, powered-by-bh attribution, or a reusable bh badge asset or snippet.",
          "invocation": {
            "modelInvocable": true,
            "userInvocable": true,
          },
          "name": "bh-badge",
          "provider": "bh-badge",
          "resourceBase": {
            "kind": "directory",
            "path": "{{badgeAssetsPath}}",
          },
          "source": "bundled",
        },
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS * 4)
})
