/** Saved global instructions across successive chat turns in a real Loader tree. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@hydra/harness-loader-smoke'

it('applies saved custom instructions and their replacements to the next chat request', async () => {
  const binScript = fileURLToPath(new URL('./fixtures/personalization/snapshot.ts', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'personalization snapshot', tempDirPrefix: 'personalization-snapshot-',
    binScript, libBinScript: binScript,
    configPath: fileURLToPath(new URL('./fixtures/imported-skills/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), processTimeoutMs: 75_000,
  })
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
    {
      "tones": [
        {
          "existing": true,
          "friendly": false,
          "pragmatic": true,
        },
        {
          "existing": false,
          "friendly": true,
          "pragmatic": false,
        },
      ],
      "turns": [
        {
          "changes": [
            "set",
          ],
          "instructions": [
            {
              "role": "user",
              "text": "<system-reminder>
    The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

    Instructions from: $BH_HOME/AGENTS.md

    Use concise Vietnamese answers.
    </system-reminder>",
            },
          ],
          "loggedInRequest": true,
          "stage": "saved",
        },
        {
          "changes": [],
          "instructions": [
            {
              "role": "user",
              "text": "<system-reminder>
    The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

    Instructions from: $BH_HOME/AGENTS.md

    Use concise Vietnamese answers.
    </system-reminder>",
            },
          ],
          "loggedInRequest": true,
          "stage": "unsaved",
        },
        {
          "changes": [
            "replace",
          ],
          "instructions": [
            {
              "role": "user",
              "text": "<system-reminder>
    The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

    Instructions from: $BH_HOME/AGENTS.md

    Use concise Vietnamese answers.
    </system-reminder>",
            },
            {
              "role": "user",
              "text": "<system-reminder>
    Updated instructions from: $BH_HOME/AGENTS.md

    This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.

    Use detailed Vietnamese answers.
    </system-reminder>",
            },
          ],
          "loggedInRequest": true,
          "stage": "updated",
        },
        {
          "changes": [
            "replace",
          ],
          "instructions": [
            {
              "role": "user",
              "text": "<system-reminder>
    The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

    Instructions from: $BH_HOME/AGENTS.md

    Use concise Vietnamese answers.
    </system-reminder>",
            },
            {
              "role": "user",
              "text": "<system-reminder>
    Updated instructions from: $BH_HOME/AGENTS.md

    This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.

    Use detailed Vietnamese answers.
    </system-reminder>",
            },
            {
              "role": "user",
              "text": "<system-reminder>
    Updated instructions from: $BH_HOME/AGENTS.md

    This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.


    </system-reminder>",
            },
          ],
          "loggedInRequest": true,
          "stage": "cleared",
        },
      ],
    }
  `)
})
