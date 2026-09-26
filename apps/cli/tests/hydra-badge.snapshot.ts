import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@hydra1902/harness-loader-smoke'
const binScript = fileURLToPath(new URL('./fixtures/hydra-badge/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/hydra-badge/cordis.yml', import.meta.url))
const defaultConfigPath = fileURLToPath(new URL('./fixtures/hydra-badge/default.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const badgeAssetsPath = fileURLToPath(new URL('../../../packages/skill/skill-badge/assets/', import.meta.url))

describe('Hydra badge assembled snapshot', () => {
  it('searches and loads the opt-in bundled skill through the shipped app', async () => {
    const disabled = await runLoaderSmoke({
      label: 'disabled Hydra badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-hydra-badge-disabled-',
      binScript,
      libBinScript: binScript,
      configPath: defaultConfigPath,
      tsconfigPath,
      processTimeoutMs: 75_000,
    })
    const enabled = await runLoaderSmoke({
      label: 'Hydra badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-hydra-badge-',
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
              "text": "Error: skill "hydra-badge" is unknown or no longer available",
              "type": "text",
            },
          ],
          "error": {
            "message": "skill "hydra-badge" is unknown or no longer available",
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
              "text": "<skill_content name="hydra-badge">
      <skill_resources>
      Base directory for this skill: {{badgeAssetsPath}}
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      # Hydra harness Badge

      Add the “powered by Hydra harness” badge using the supplied artwork.

      ## Asset

      Use [\`hydra-badge.png\`](hydra-badge.png) from this skill directory. The source image is 1080×168; render at 180×28 and preserve its aspect ratio.

      ## Markdown

      Copy the PNG beside the target document, then use:

      \`\`\`markdown
      ![Powered by Hydra harness](hydra-badge.png)
      \`\`\`

      Adjust the relative path to the copied file. For a pull request, merge request, or system that accepts image uploads, upload the bundled PNG and use the returned image URL. Do not reference a local filesystem path in remote content.

      ## Usage rules

      - Preserve the badge's 180×28 display dimensions and aspect ratio where the target supports sizing.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Use the supplied colors, Hydra logo, and label. Link to a project only when its URL is provided or verified.

      </skill_instructions>
      </skill_content>",
              "type": "text",
            },
          ],
          "isError": false,
          "value": {
            "content": "# Hydra harness Badge

      Add the “powered by Hydra harness” badge using the supplied artwork.

      ## Asset

      Use [\`hydra-badge.png\`](hydra-badge.png) from this skill directory. The source image is 1080×168; render at 180×28 and preserve its aspect ratio.

      ## Markdown

      Copy the PNG beside the target document, then use:

      \`\`\`markdown
      ![Powered by Hydra harness](hydra-badge.png)
      \`\`\`

      Adjust the relative path to the copied file. For a pull request, merge request, or system that accepts image uploads, upload the bundled PNG and use the returned image URL. Do not reference a local filesystem path in remote content.

      ## Usage rules

      - Preserve the badge's 180×28 display dimensions and aspect ratio where the target supports sizing.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Use the supplied colors, Hydra logo, and label. Link to a project only when its URL is provided or verified.
      ",
            "name": "hydra-badge",
            "provider": "hydra-badge",
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
      - \`hydra-badge\`: Add the official “powered by Hydra harness” badge to documents, pull requests, merge requests, and other content produced with Hydra harness. Use whenever creating a pull request or merge request. Also use when the user asks for a Hydra badge, powered-by-hydra attribution, or a reusable Hydra badge asset or snippet.
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
                "description": "Add the official “powered by Hydra harness” badge to documents, pull requests, merge requests, and other content produced with Hydra harness. Use whenever creating a pull request or merge request. Also use when the user asks for a Hydra badge, powered-by-hydra attribution, or a reusable Hydra badge asset or snippet.",
                "name": "hydra-badge",
              },
            ],
            "truncated": false,
          },
        },
        "summary": {
          "description": "Add the official “powered by Hydra harness” badge to documents, pull requests, merge requests, and other content produced with Hydra harness. Use whenever creating a pull request or merge request. Also use when the user asks for a Hydra badge, powered-by-hydra attribution, or a reusable Hydra badge asset or snippet.",
          "invocation": {
            "modelInvocable": true,
            "userInvocable": true,
          },
          "name": "hydra-badge",
          "provider": "hydra-badge",
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
