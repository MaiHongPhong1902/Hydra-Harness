import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@hydraharness/harness-loader-smoke'

const binScript = fileURLToPath(new URL('./fixtures/imported-capabilities/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/imported-skills/cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const mcpFixture = fileURLToPath(new URL('../../../packages/mcp/mcp-client/tests/fixture-server.ts', import.meta.url))

describe('imported hooks and MCP assembled snapshot', () => {
  it('runs reviewed hooks and approved MCP tools and removes both on disable', async () => {
    const result = await runLoaderSmoke({
      label: 'imported capabilities snapshot', tempDirPrefix: 'imported-capabilities-',
      binScript, libBinScript: binScript, configPath, tsconfigPath, processTimeoutMs: 75_000,
      async prepare(cwd) {
        const root = join(cwd, 'plugin')
        await writeFile(join(cwd, 'user-hook.cjs'), [
          "require('node:fs').readFileSync(0, 'utf8');",
          "console.log(JSON.stringify({hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: 'User-owned hook'}}));",
          '',
        ].join('\n'))
        await mkdir(join(root, '.codex-plugin'), { recursive: true })
        const command = 'node "${CLAUDE_PLUGIN_ROOT}/hook.cjs"'
        await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
          name: 'capability-fixture', version: '1.0.0',
          mcpServers: { local: { command: process.execPath, args: [mcpFixture] } },
          hooks: { UserPromptSubmit: [{ hooks: [{ command }] }] },
        }))
        await writeFile(join(root, 'hook.cjs'), [
          "const fs = require('node:fs'); const path = require('node:path');",
          "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
          'const valid = process.env.PLUGIN_ROOT === process.env.CLAUDE_PLUGIN_ROOT && process.env.PLUGIN_DATA === process.env.CLAUDE_PLUGIN_DATA;',
          "fs.appendFileSync(path.join(process.env.PLUGIN_DATA, 'hook-runs.txt'), input.prompt + '\\n');",
          "console.log(JSON.stringify({hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: 'Reviewed hook: ' + input.prompt + '; plugin environment=' + valid}}));",
          '',
        ].join('\n'))
      },
    })
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
      {
        "allowed": {
          "isError": false,
          "text": "admin__reset",
        },
        "defaultDenied": true,
        "denied": {
          "isError": true,
          "text": "Error: MCP tool admin__reset is disabled by its plugin policy",
        },
        "hookRuns": "Check trusted
      ",
        "remaining": 0,
        "startup": "started",
        "turns": [
          {
            "hooks": [],
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check pending",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check pending",
              },
            ],
            "state": "pending",
          },
          {
            "hooks": [
              "hook/invoked",
              "hook/result",
            ],
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check trusted",
              },
              {
                "source": {
                  "kind": "plugin",
                  "plugin": "hooks-codex",
                },
                "text": "Reviewed hook: Check trusted; plugin environment=true",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check trusted",
              },
              {
                "source": {
                  "kind": "plugin",
                  "plugin": "hooks-codex",
                },
                "text": "Reviewed hook: Check trusted; plugin environment=true",
              },
            ],
            "state": "trusted",
          },
          {
            "hooks": [],
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check untrusted",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check untrusted",
              },
            ],
            "state": "untrusted",
          },
          {
            "hooks": [],
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check disabled",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check disabled",
              },
            ],
            "state": "disabled",
          },
          {
            "hooks": [
              "hook/invoked",
              "hook/result",
            ],
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check user-codex",
              },
              {
                "source": {
                  "kind": "plugin",
                  "plugin": "hooks-codex",
                },
                "text": "User-owned hook",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check user-codex",
              },
              {
                "source": {
                  "kind": "plugin",
                  "plugin": "hooks-codex",
                },
                "text": "User-owned hook",
              },
            ],
            "state": "user-codex",
          },
          {
            "hooks": [
              "hook/invoked",
              "hook/result",
            ],
            "logged": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check user-claude",
              },
              {
                "source": {
                  "kind": "plugin",
                  "plugin": "hooks-claude-code",
                },
                "text": "User-owned hook",
              },
            ],
            "request": [
              {
                "source": {
                  "kind": "user",
                },
                "text": "Check user-claude",
              },
              {
                "source": {
                  "kind": "plugin",
                  "plugin": "hooks-claude-code",
                },
                "text": "User-owned hook",
              },
            ],
            "state": "user-claude",
          },
        ],
      }
    `)
  })
})
