// @vitest-environment jsdom
/** First-run provider configuration navigation over the shared Models join. */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Schema from '@hydra1902/schemastery'
import type { RpcResponse, SettingsNamespaceView } from '@hydra1902/harness-api-remotes/client'
import { bindSnapshotSelector } from '@hydra1902/harness-client-test-runtime'
import { ProviderOnboarding } from '../src/client/ProviderOnboarding.tsx'
import { OnboardingModal } from '../src/client/OnboardingModal.tsx'
import type { ProviderOnboardingProps } from '../src/client/ProviderOnboarding.tsx'
import { SettingsDescribeMirror } from '@hydra1902/harness-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import {
  OFFICIAL_DEEPSEEK_DECLINED_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE,
} from '../src/onboarding-copy.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `onboarding-${nextRpc++}` as never, result: { ok: true, value } }
}
function fail<T>(message: string): RpcResponse<T> {
  return {
    rpcId: `onboarding-${nextRpc++}` as never,
    result: { ok: false, error: { code: 'internal', message, details: {} } },
  }
}

const DeepSeekConfig = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref'),
  baseURL: Schema.string().pattern(/^https:\/\//),
  reasoningEffort: Schema.union(['off', 'low', 'high', 'max']),
  defaultContextWindow: Schema.number().step(1).min(1),
  models: Schema.array(Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    description: Schema.string(),
    contextWindow: Schema.number().step(1).min(1),
  })),
})

function deepSeekNamespace(apiKeyEnv: string | null): SettingsNamespaceView {
  const value = apiKeyEnv === null ? {} : { apiKeyEnv }
  return {
    ns: 'llm-deepseek',
    schema: JSON.parse(JSON.stringify(DeepSeekConfig.toJSON())) as unknown,
    value,
    base: value,
    user: {},
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

function harness(options: {
  provider?: boolean
  providerSettingsNs?: string
  providerActive?: boolean
  settingsNamespace?: boolean
  apiKeyEnv?: string | null
  configured?: () => boolean
  credential?: { source?: string; writable: boolean }
  describeFailure?: string
  settingsWritable?: boolean
  providersReject?: boolean
  setFailure?: string
  setReject?: string
  declined?: boolean
} = {}) {
  if (document.getElementById('root') === null) {
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
  }
  let fileConfigured = false
  const configured = options.configured ?? (() => fileConfigured)
  const apiKeyEnv = options.apiKeyEnv === undefined ? 'DEEPSEEK_API_KEY' : options.apiKeyEnv
  const mutate = vi.fn(() => Promise.resolve(ok(deepSeekNamespace(apiKeyEnv))))
  const set = vi.fn((_payload: { ref: string; value: string }) => {
    if (options.setReject !== undefined) return Promise.reject(new Error(options.setReject))
    if (options.setFailure !== undefined) return Promise.resolve(fail(options.setFailure))
    fileConfigured = true
    return Promise.resolve(ok({}))
  })
  const face = {
    llm: {
      providers: () => {
        if (options.providersReject === true) return Promise.reject(new Error('provider transport unavailable'))
        return Promise.resolve(ok({
          providers: options.provider === false
            ? []
            : [{
              provider: 'deepseek-official',
              displayName: 'DeepSeek',
              settingsNs: options.providerSettingsNs ?? 'llm-deepseek',
              settingsPath: [],
              active: options.providerActive ?? true,
            }],
        }))
      },
    },
    settings: {
      describe: () => Promise.resolve(ok({
        writable: options.settingsWritable ?? true,
        hasDocument: false,
        namespaces: [
          ...options.settingsNamespace === false ? [] : [deepSeekNamespace(apiKeyEnv)],
          ...options.declined === true
            ? [{
              ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
              schema: {},
              value: { [OFFICIAL_DEEPSEEK_DECLINED_FIELD]: true },
              user: { [OFFICIAL_DEEPSEEK_DECLINED_FIELD]: true },
              applies: 'live' as const,
              secrets: [] as never[],
              revision: 0,
            }]
            : [],
        ],
      })),
      mutate,
    },
    credentials: {
      describe: () => options.describeFailure === undefined
        ? Promise.resolve(ok({
          credentials: {
            DEEPSEEK_API_KEY: {
              configured: configured(),
              ...configured() && options.credential?.source !== undefined
                ? { source: options.credential.source }
                : {},
              writable: options.credential?.writable ?? true,
            },
          },
        }))
        : Promise.resolve(fail(options.describeFailure)),
      set,
    },
  }
  const controller = new ModelsSettingsStore(face as never, settingsSchema, new SettingsDescribeMirror(face as never))
  const openSection = vi.fn()
  const complete = vi.fn()
  const unusedHook = (() => { throw new Error('unused standard hook') }) as never
  const props: ProviderOnboardingProps = {
    stepId: 'provider-setup',
    complete,
    openSection,
    useSessions: unusedHook,
    useWorkspaces: unusedHook,
    controller,
    useModels: bindSnapshotSelector(controller.store),
  }
  return {
    controller, complete, openSection, props, mutate, set,
    configure: () => { fileConfigured = true },
  }
}

describe('ProviderOnboarding', () => {
  it('renders a form modal without an application root or forced title focus', () => {
    render(<OnboardingModal title="Setup"><input aria-label="Provider" autoFocus /></OnboardingModal>)
    expect(screen.getByRole('dialog', { name: 'Setup' })).toBeTruthy()
    expect(screen.getByRole('heading').getAttribute('tabindex')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Provider' }))
  })
  it('opens Models without rendering a key dialog or writing configuration', async () => {
    const h = harness()
    render(<ProviderOnboarding {...h.props} />)
    await waitFor(() => { expect(h.openSection).toHaveBeenCalledWith('models') })
    expect(h.complete).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText('API key')).toBeNull()
    expect(document.getElementById('root')?.inert).not.toBe(true)
    expect(h.set).not.toHaveBeenCalled()
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('offers provider selection even when official DeepSeek was dismissed', async () => {
    const h = harness({ declined: true })
    render(<ProviderOnboarding {...h.props} />)
    await waitFor(() => { expect(h.openSection).toHaveBeenCalledWith('models') })
    expect(h.mutate).not.toHaveBeenCalled()
  })

  it('does not open Settings for configured or unavailable deployments', async () => {
    for (const h of [
      harness({ configured: () => true, credential: { source: 'env', writable: false } }),
      harness({ apiKeyEnv: null }),
      harness({ describeFailure: 'credentials unavailable' }),
      harness({ settingsWritable: false }),
      harness({ providersReject: true }),
      harness({ provider: false }),
      harness({ settingsNamespace: false }),
    ]) {
      const view = render(<ProviderOnboarding {...h.props} />)
      await waitFor(() => { expect(h.complete).toHaveBeenCalledOnce() })
      expect(h.openSection).not.toHaveBeenCalled()
      view.unmount()
    }
  })
})
