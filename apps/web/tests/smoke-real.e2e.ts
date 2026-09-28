// Keyless Web-host smoke: exercise the real CLI and local streaming providers.
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, requireDist } from './support.ts'

const WEB_SURFACE_PROMPT = fileURLToPath(new URL('./snapshots/web-runtime-context/web-surface-prompt.expected.md', import.meta.url))

function waitForReadyLine(child: ChildProcess): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let out = ''
    const timer = setTimeout(() => { reject(new Error(`hydra web not ready in 90s; output:\n${out}`)) }, 90_000)
    const onData = (chunk: Buffer): void => {
      out += chunk.toString()
      const match = /hydra web: (http:\/\/[^\s]+)/.exec(out)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolveReady(match[1])
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`hydra web exited early (code ${code}); output:\n${out}`))
    })
  })
}

async function rpc<T>(baseUrl: string, method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `smoke-${method}`,
      method,
      payload,
    }),
  })
  if (!response.ok) throw new Error(`${method} failed over HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as {
    result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
  }
  if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

async function selectDefaultModel(baseUrl: string, sessionId: string): Promise<void> {
  await rpc(baseUrl, 'session.selectModel', {
    sessionId,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
}

interface HistoryPage {
  events: { event: { type: string; data: unknown } }[]
  hasMore: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasAssistantMarker(page: HistoryPage, marker: string): boolean {
  return page.events.some(({ event }) => {
    if (event.type !== 'assistant/message' || !isRecord(event.data) || !isRecord(event.data.message)) return false
    const content = event.data.message.content
    if (!Array.isArray(content)) return false
    return content.some(block =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.includes(marker))
  })
}

async function history(baseUrl: string, sessionId: string): Promise<HistoryPage> {
  return rpc<HistoryPage>(baseUrl, 'session.history', { sessionId, maxMessages: 10 })
}

describe('hydra web keyless CLI smoke', () => {
  it('listens on 127.0.0.1 by default', async () => {
    requireDist()
    const sessionsDir = mkdtempSync(join(tmpdir(), 'hydra-web-keyless-'))
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '0'],
      {
        cwd: sessionsDir,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-no-call',
          HYDRA_HOME: join(sessionsDir, '.hydra'),
          HYDRA_AGENTS_HOME: join(sessionsDir, '.agents'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      const readyUrl = await waitForReadyLine(child)
      expect(readyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect((await fetch(readyUrl)).status).toBe(200)
    } finally {
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('routes web runtime context and workspace instructions through the real CLI request', async () => {
    requireDist()
    const workspace = mkdtempSync(join(tmpdir(), 'hydra-web-workspace-'))
    mkdirSync(join(workspace, '.git'))
    writeFileSync(join(workspace, 'AGENTS.md'), 'web-workspace-context-probe\n')

    interface NativeProviderRequest {
      messages?: { role?: string; content?: string }[]
      tools?: { function?: { name?: string; description?: string } }[]
    }
    let resolveProviderRequests!: (requests: NativeProviderRequest[]) => void
    const requests: NativeProviderRequest[] = []
    const providerRequests = new Promise<NativeProviderRequest[]>((resolve) => {
      resolveProviderRequests = resolve
    })
    const provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as NativeProviderRequest
        if ((parsed.tools?.length ?? 0) > 0) requests.push(parsed)
        if (requests.length === 1) resolveProviderRequests(requests)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
          'data: {"choices":[{"delta":{"content":"done"}}]}',
          'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (address === null || typeof address === 'string') throw new Error('mock provider did not bind a TCP port')
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '0'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-workspace',
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          HYDRA_HOME: join(workspace, '.hydra'),
          HYDRA_AGENTS_HOME: join(workspace, '.agents'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      const baseUrl = await waitForReadyLine(child)
      const created = await rpc<{ sessionId: string }>(baseUrl, 'session.create', {})
      await selectDefaultModel(baseUrl, created.sessionId)
      await rpc<{ accepted: true }>(baseUrl, 'session.prompt', {
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'Tôi muốn cải thiện agent' }],
      })
      const capturedRequests = await Promise.race([
        providerRequests,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('provider request not received in 10s')) }, 10_000).unref()
        }),
      ])
      const captured = capturedRequests[0]
      if (captured === undefined) {
        throw new Error('provider did not receive the workspace projection request')
      }
      const workspaceMessage = captured.messages?.find(message =>
        message.role === 'user' && message.content?.includes('web-workspace-context-probe'))
      const improvementContract = captured.messages?.find(message =>
        message.role === 'user' && message.content?.includes('Immediate task contract:'))
      const systemMessage = captured.messages?.find(message => message.role === 'system')
      const expectedWebSection = readFileSync(WEB_SURFACE_PROMPT, 'utf8').trimEnd()
        .replace('{{webUrl}}', baseUrl)
      expect(systemMessage?.content).toContain(expectedWebSection)
      expect(workspaceMessage).toMatchInlineSnapshot(`
        {
          "content": "<system-reminder>
        The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.

        Instructions from: AGENTS.md

        web-workspace-context-probe

        </system-reminder>",
          "role": "user",
        }
      `)
      expect(improvementContract?.content).toContain('Do not scan unrelated fixtures or invent a broad category menu.')
      expect(captured.tools?.map(tool => tool.function?.name)
        .filter(name => name === 'web_search' || name === 'web_fetch'))
        .toMatchInlineSnapshot(`
          [
            "web_fetch",
            "web_search",
          ]
        `)
      expect(captured.tools?.find(tool => tool.function?.name === 'ask_user_question')?.function?.description)
        .toContain('Do not use this for greetings, acknowledgements, casual chat, vague requests, or generic action, task, or tool menus.')
    } finally {
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      await new Promise<void>(resolveClose => provider.close(() => { resolveClose() }))
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('retries a partial transport failure through the shipped Web composition', async () => {
    requireDist()
    const workspace = mkdtempSync(join(tmpdir(), 'hydra-web-retry-'))
    const promptMarker = 'WEB_RETRY_REQUEST'
    const recoveredMarker = 'WEB_RETRY_RECOVERED'
    let mainAttempts = 0
    const provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body) as { max_tokens?: number; messages?: unknown[] }
        const titleRequest = parsed.max_tokens === 64
        const mainRequest = !titleRequest && body.includes(promptMarker)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (!mainRequest) {
          response.end([
            'data: {"choices":[{"delta":{"content":"Web retry title"}}]}',
            'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
            'data: [DONE]',
            '',
          ].join('\n\n'))
          return
        }
        mainAttempts++
        if (mainAttempts === 1) {
          response.write('data: {"choices":[{"delta":{"content":"WEB_RETRY_DISCARDED"}}]}\n\n')
          setTimeout(() => { response.destroy() }, 20)
          return
        }
        response.end([
          `data: {"choices":[{"delta":{"content":"${recoveredMarker}"}}]}`,
          'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (address === null || typeof address === 'string') throw new Error('mock provider did not bind a TCP port')
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '0'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-retry',
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          HYDRA_HOME: join(workspace, '.hydra'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      const baseUrl = await waitForReadyLine(child)
      const created = await rpc<{ sessionId: string }>(baseUrl, 'session.create', {})
      await selectDefaultModel(baseUrl, created.sessionId)
      await rpc<{ accepted: true }>(baseUrl, 'session.prompt', {
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptMarker }],
      })
      let page: HistoryPage | undefined
      await expect.poll(async () => {
        page = await history(baseUrl, created.sessionId)
        return hasAssistantMarker(page, recoveredMarker)
      }, { timeout: 20_000 }).toBe(true)
      if (page === undefined) throw new Error('retry history was not observed')
      const retry = page.events.find(({ event }) => event.type === 'llm/retry')?.event
      expect(mainAttempts).toBe(2)
      expect(retry?.data).toMatchObject({
        turn: 1,
        step: 1,
        retry: 1,
        maxRetries: 5,
        failure: { code: 'TRANSPORT' },
      })
      expect(JSON.stringify(page.events)).toContain('WEB_RETRY_DISCARDED')
    } finally {
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      await new Promise<void>(resolveClose => provider.close(() => { resolveClose() }))
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 120_000)

  it('HYDRA_TOOLS_MODE=code collapses the provider wire tools to run_code with the SDK prompt section', async () => {
    requireDist()
    const workspace = mkdtempSync(join(tmpdir(), 'hydra-web-code-mode-'))

    interface CodeModeProviderRequest {
      messages?: { role?: string; content?: string }[]
      tools?: { function?: { name?: string } }[]
    }
    let resolveProviderRequest!: (request: CodeModeProviderRequest) => void
    const providerRequest = new Promise<CodeModeProviderRequest>((resolve) => {
      resolveProviderRequest = resolve
    })
    const provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        resolveProviderRequest(JSON.parse(body) as CodeModeProviderRequest)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          'data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
          'data: {"choices":[{"delta":{"content":"done"}}]}',
          'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (address === null || typeof address === 'string') throw new Error('mock provider did not bind a TCP port')
    const tsxLoader = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href
    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, join(REPO_ROOT, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--port', '0'],
      {
        cwd: workspace,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-code-mode',
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
          HYDRA_TOOLS_MODE: 'code',
          HYDRA_HOME: join(workspace, '.hydra'),
          HYDRA_AGENTS_HOME: join(workspace, '.agents'),
          TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.json'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    try {
      const baseUrl = await waitForReadyLine(child)
      const created = await rpc<{ sessionId: string }>(baseUrl, 'session.create', {})
      await selectDefaultModel(baseUrl, created.sessionId)
      await rpc<{ accepted: true }>(baseUrl, 'session.prompt', {
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'go' }],
      })
      const captured = await Promise.race([
        providerRequest,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => { reject(new Error('provider request not received in 10s')) }, 10_000).unref()
        }),
      ])
      expect(captured.tools?.map(tool => tool.function?.name)).toEqual(['run_code'])
      const system = captured.messages?.find(message => message.role === 'system')
      expect(system?.content).toContain('## Writing code for run_code')
      expect(system?.content).toContain('declare const tools')
    } finally {
      const closed = child.exitCode === null
        ? new Promise<void>((resolveClose) => { child.once('close', () => { resolveClose() }) })
        : Promise.resolve()
      if (child.exitCode === null) child.kill('SIGTERM')
      await closed
      await new Promise<void>(resolveClose => provider.close(() => { resolveClose() }))
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
