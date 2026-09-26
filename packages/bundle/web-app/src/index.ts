/**
 * @hydra1902/harness-web-app — the browser-surface bundle's runtime glue plugin
 * plus the bundle patch (`cordis.patch.yml`, declared by the `hydra.bundle.patch`
 * manifest field). The plugin owns the browser-surface glue: it resolves
 * the built frontend dist (workspace knowledge of this bundle, never user
 * config), mounts the `frontend-static` fallback owner over it, registers the
 * harness-source and web-surface prompt sections, the bash-visible web runtime
 * variable, the URL line, and the default-browser handoff. App command-line
 * values arrive through the `webStartup` service expressions in the bundle
 * patch.
 * @module @hydra1902/harness-web-app
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Context } from '@hydra1902/cordis'
import z from '@hydra1902/schemastery'
import type { PreStepDecision } from '@hydra1902/harness-agent'
import { addHarnessSourceSection } from '@hydra1902/harness-app-boot'
import * as FrontendStatic from '@hydra1902/harness-host-frontend-static'
import { launchEnvironmentOf } from '@hydra1902/harness-launch-environment'
import { createUserMessage } from '@hydra1902/harness-llm'
import type { UserMessage } from '@hydra1902/harness-session'
import { scrubbedParentEnv } from '@hydra1902/harness-subprocess'
import type {} from '@hydra1902/cordis-plugin-loader'
import type {} from '@hydra1902/harness-host-webserver'
import type {} from '@hydra1902/harness-system-prompt'
import type {} from '@hydra1902/harness-shell-env'

/** Stable Cordis plugin name. */
export const name = 'web-app'

/** This hydra installation's root, from either this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

/** Runtime service that releases Web rows after bind-dependent values resolve. */
const WEB_RUNTIME_SERVICE = 'webRuntime'

/** Services required before the web runtime can mount. */
export const inject = ['webServer']

/** Plugin config: composed deployment settings plus per-invocation command-line values. */
export interface Config {
  /** Permit default-browser handoff after the Loader tree settles; an SSH launch suppresses it. */
  openBrowser: boolean
  /** Print the URL line on activation; a non-interactive layer can turn it off. */
  printUrl: boolean
  /**
   * Register the model-visible surface context (the `app:web-surface` prompt
   * section and the `HYDRA_WEB_URL` bash variable). A one-shot non-interactive
   * layer can turn it off when its user is not in the GUI, so the
   * orientation text would be false.
   */
  surfaceContext: boolean
  /** Explicit `--trusted-host` authorities from this invocation. */
  trustedHosts: string[]
}

export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.boolean().default(true),
  surfaceContext: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
})

/** Bind-dependent Web values shared by the trust fence and URL display. */
export interface WebRuntimeValues {
  /** LAN IPv4 literals sampled once when the server binds all interfaces. */
  lanAddresses: string[]
  /** LAN literals followed by explicit invocation authorities. */
  trustedHosts: string[]
}

/** Environment variable naming the canonical local URL of this Web GUI. */
const HYDRA_WEB_URL = 'HYDRA_WEB_URL' as const

// Display-only mirror of the webserver schema's loopback host: the address the
// local URL always prints. Not a source of truth — the schema is.
const LOOPBACK_HOST = '127.0.0.1'
/** The webserver schema's all-interfaces bind literal. */
const ALL_INTERFACES_HOST = '0.0.0.0'

// oxlint-disable-next-line @stylistic/max-len
const AGENT_IMPROVEMENT_REQUEST = /(?:\b(?:improv(?:e|ing|ement)|enhanc(?:e|ing|ement)|optimi[sz](?:e|ing|ation))\b.*\bagent\b|\bagent\b.*\b(?:improv(?:e|ing|ement)|enhanc(?:e|ing|ement)|optimi[sz](?:e|ing|ation))\b|(?:cải thiện|nâng cấp|tối ưu).*agent\b|\bagent\b.*(?:cải thiện|nâng cấp|tối ưu))/iu

const AGENT_IMPROVEMENT_CONTRACT = 'Immediate task contract: this direct request is to improve agent behavior. If the user message or current context names a directly relevant session or workspace artifact, inspect exactly that one with one read-only tool call. Otherwise, do not scan or open arbitrary workspace files merely to satisfy this contract: say no directly relevant artifact is available, name the one concrete evidence needed for one narrow next check, and stop. If that inspection finds no directly relevant observable decision failure, say so in at most two concise sentences, name the one concrete evidence needed next, and stop. Do not call goal tools or exit_plan_mode, write a broad improvement plan, generic recommendations, or an approval question.'

function isDirectAgentImprovementRequest(messages: readonly UserMessage[]): boolean {
  return messages.some(message => message.source.kind === 'user'
    && message.content.some(block => block.type === 'text' && AGENT_IMPROVEMENT_REQUEST.test(block.text)))
}

function agentImprovementContract(messages: readonly UserMessage[], step: number): UserMessage | undefined {
  if (step !== 1 || !isDirectAgentImprovementRequest(messages)) return
  return createUserMessage({
    content: [{ type: 'text', text: AGENT_IMPROVEMENT_CONTRACT }],
    source: { kind: 'plugin', plugin: name, form: 'instructions' },
  })
}

/** Whether this process was launched through SSH, including a forwarded-port session. */
function launchedThroughSsh(ctx: Context): boolean {
  const environment = launchEnvironmentOf(ctx)
  return ['SSH_CONNECTION', 'SSH_TTY'].some((name) => {
    const value = environment.getFrom(name, ['process'])?.value
    return value !== undefined && value !== ''
  })
}

const BROWSER_OPENER_MODULE = import.meta.resolve('open')

const BROWSER_OPENER_PROGRAM = `
try {
  const { default: open } = await import(${JSON.stringify(BROWSER_OPENER_MODULE)})
  const launcher = await open(process.argv[1])
  if (process.platform === 'win32') {
    // open resolves at PowerShell spawn; keep it referenced until that launcher hands the URL to Windows.
    const code = launcher.exitCode ?? await new Promise((resolve, reject) => {
      function onError(error) {
        launcher.off('close', onClose)
        reject(error)
      }
      function onClose(code) {
        launcher.off('error', onError)
        resolve(code)
      }
      launcher.ref()
      launcher.once('error', onError)
      launcher.once('close', onClose)
    })
    if (code !== 0) throw new Error('browser operating-system launcher exited with code ' + String(code))
  }
  process.exitCode = 0
} catch (error) {
  // The parent turns this exit into the manual-URL warning.
  console.error(error)
  process.exitCode = 1
}
`

/**
 * Resolve one LAN-trust snapshot from the active server bind.
 *
 * Derived entries are port-less IP literals: DNS rebinding needs an
 * attacker-controlled name, while an IP-literal Host is safe on any port and
 * an OS-assigned port is unknowable before bind.
 * @param bindHost - the active webserver bind host.
 * @param extra - explicit `--trusted-host` values, in argument order.
 * @returns the LAN display addresses and invocation-derived fence authorities.
 */
export function resolveLanTrust(bindHost: string, extra: readonly string[]): WebRuntimeValues {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST
    ? Object.values(networkInterfaces()).flat()
      .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
      .map(iface => iface.address)
    : []
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] }
}

/** Model-visible orientation and acceptance boundary for sessions created through `hydra web`. */
function webSurfacePrompt(webUrl: string): string {
  const updateContract = 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
    + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
    + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  return `You are interacting with the user through the Hydra harness Web GUI at ${webUrl}. `
    + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'Classify the user message before planning. If it is only a greeting, acknowledgement, or casual chat, reply with one short natural conversational sentence and stop; do not ask a question, propose work, mention the GUI, workspace, tools, policy, permissions, or options, or take any action. '
    + 'Treat a stated goal as a task even when high-level: take the smallest safe useful step. Ask only when a material fact normal inspection cannot establish blocks that step; then ask one short natural question for that fact, never a generic action, task, or tool menu. '
    + 'An unbounded but inspectable goal is not a blocker: when asked to improve an agent, inspect one directly relevant session or workspace evidence item for one observable decision failure; do not scan arbitrary workspace fixtures merely to find evidence. If none is directly relevant, state the one narrow evidence item needed next and stop; do not ask the user to choose a broad category such as performance, reliability, safety, or UX unless they explicitly asked for that choice. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + updateContract
    + 'Starting another server does not update this GUI. '
    + 'The apps/web Vite entry builds the shell but is not a standalone application because only hydra web injects window.__HYDRA_BOOT__. '
    + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
}

/** Resolve the canonical loopback URL from the active Web server. */
function localWebUrl(ctx: Context): string {
  const port = ctx.get('webServer')?.port
  if (port === undefined) throw new Error('web-app: webServer service missing while resolving Web runtime')
  return `http://${LOOPBACK_HOST}:${String(port)}`
}

/** Dist location is workspace knowledge of this bundle: resolved through the frontend package exports, not configured. */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@hydra1902/harness-web-frontend/dist/index.html')
  } catch {
    /* v8 ignore next 2 -- reachable only on a checkout without a built dist; the test tree builds it */
    throw new Error('web-app: frontend dist not built; run pnpm run build from the repository root first')
  }
}

/** Start the maintained platform opener without forwarding Harness credentials. */
function spawnBrowserLauncher(url: string): ChildProcess {
  return spawn(process.execPath, [
    '--input-type=module',
    '--eval', BROWSER_OPENER_PROGRAM,
    '--', url,
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'inherit', 'pipe'],
  })
}

/** Hand one URL to the operating system's default browser. */
async function openBrowser(url: string): Promise<void> {
  const launcher = spawnBrowserLauncher(url)
  let launcherStderr = ''
  launcher.stderr?.setEncoding('utf8')
  launcher.stderr?.on('data', (chunk: string) => { launcherStderr += chunk })
  await new Promise<void>((resolve, reject) => {
    function onError(error: Error): void {
      launcher.off('close', onClose)
      reject(error)
    }
    function onClose(code: number | null): void {
      launcher.off('error', onError)
      if (code !== 0) {
        const firstLine = launcherStderr.trim().split(/\r?\n/u)[0]
        const reason = firstLine === undefined || firstLine === ''
          ? `browser launcher exited with code ${String(code)}`
          : firstLine.replace(/^(?:[A-Za-z]*Error):\s*/u, '')
        reject(new Error(reason))
        return
      }
      if (launcherStderr !== '') process.stderr.write(launcherStderr)
      resolve()
    }
    launcher.once('error', onError)
    launcher.once('close', onClose)
  })
}

/** Test hooks for the built dist and native browser handoff; production never mutates them. */
export const internals: {
  resolveDistIndex: () => string
  openBrowser: (url: string) => Promise<void>
  agentImprovementContract: (messages: readonly UserMessage[], step: number) => UserMessage | undefined
} = { resolveDistIndex, openBrowser, agentImprovementContract }

/**
 * Mount the Web runtime: dist serving, surface prompt, the bash runtime
 * variable, the URL line, and the default-browser handoff.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const runtime = resolveLanTrust(ctx.webServer.host, config.trustedHosts)
  // The loopback URL belongs to this host. Under SSH, the operator reaches it
  // through a local forwarding address that this process cannot derive.
  const handoffBrowser = config.openBrowser && !launchedThroughSsh(ctx)
  // Release dependent rows only after bind-dependent trust has been sampled once.
  ctx.provide(WEB_RUNTIME_SERVICE, runtime)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  if (config.surfaceContext) {
    ctx.on('agent/pre-step', async ({ messages, step }, next): Promise<PreStepDecision> => {
      const decision = await next()
      const contract = agentImprovementContract(messages, step)
      if (decision.kind === 'reject' || contract === undefined) return decision
      return {
        kind: 'enter',
        messages: [...decision.messages, contract],
      }
    })
    ctx.inject(['systemPrompt'], (promptCtx) => {
      addHarnessSourceSection(promptCtx, SOURCE_ROOT)
      promptCtx.systemPrompt.section({
        name: 'app:web-surface',
        order: -98,
        text: () => webSurfacePrompt(localWebUrl(promptCtx)),
      })
    })
    ctx.inject(['shellEnv'], (runtimeCtx) => {
      runtimeCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          [HYDRA_WEB_URL]: { description: 'Canonical local URL of the Hydra harness Web GUI serving this session.' },
        },
        resolve: () => ({ [HYDRA_WEB_URL]: localWebUrl(runtimeCtx) }),
      })
    })
  }
  if (config.printUrl || handoffBrowser) {
    // The URL line and browser handoff are readiness signals: supervisors RPC
    // as soon as they observe the line, while a browser requests the page as
    // soon as it opens. Neither may run while sibling rows such as the /api
    // route owner are still mounting. Await Loader settlement first; a
    // hand-built tree without a Loader is already the complete tree.
    const announceReady = (): void => {
      const webUrl = localWebUrl(ctx)
      // Reuse the exact LAN snapshot provided to the /api trust fence.
      const lanCandidate = runtime.lanAddresses[0]
      const port = ctx.webServer.port
      if (config.printUrl) {
        console.log(`hydra web: ${webUrl}${lanCandidate === undefined ? '' : ` (LAN: http://${lanCandidate}:${String(port)})`}`)
      }
      if (handoffBrowser) {
        console.log('hydra web: opening the default browser; pass --no-open to disable')
        void internals.openBrowser(webUrl).catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          console.error(`web-app: could not open the default browser because ${reason}; visit ${webUrl} manually`)
        })
      }
    }
    // This row's own activation can precede a sibling failure. The app owns
    // readiness by waiting for its Loader tree, or announces at once in a
    // hand-built context without Loader.
    const settled = ctx.get('loader')?.await()
    if (settled === undefined) announceReady()
    else {
      void settled.then(() => {
        // The tree can be disposed while the boot was in flight (early
        // SIGTERM); a URL line or browser tab for a dead server would only
        // mislead, and reading the torn-down port would turn a clean shutdown
        // into a crash.
        if (ctx.get('webServer') !== undefined) announceReady()
      // Loader reports a failed boot; this row only stays quiet.
      }, () => {})
    }
  }
}
