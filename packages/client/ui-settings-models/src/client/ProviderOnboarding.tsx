/** First-run navigation to the shared provider configuration page. */
import { useEffect } from 'react'
import type { InjectFace, PropsRuntime } from '@hydraharness/harness-client-ui-slots'
import type { ModelsSettingsStore } from './store.ts'
import { onboardingReadiness } from './store.ts'

/** Shared Models join used to decide whether provider setup is needed. */
export interface ProviderOnboardingInjected {
  /** Page snapshot bound by the slot renderer as useModels. */
  hooks: { models: ModelsSettingsStore['store'] }
  /** Loads the same provider, settings, and credential facts as Models. */
  controller: ModelsSettingsStore
}

/** Coordinator callbacks and the shared Models join. */
export type ProviderOnboardingProps =
  PropsRuntime<'settings.onboarding'> & InjectFace<ProviderOnboardingInjected>

/**
 * Open Models when no provider is usable, then complete this coordinator pass.
 * The Settings panel owns dismissal and all provider selection and writes.
 * @param props - coordinator callbacks and shared Models state.
 * @returns null; this step renders no separate credential dialog.
 */
export function ProviderOnboarding(props: ProviderOnboardingProps): null {
  const { complete, openSection, controller, useModels } = props
  const state = useModels(snapshot => snapshot)
  const readiness = onboardingReadiness(state)

  useEffect(() => {
    if (state.status === 'idle') void controller.load()
  }, [controller, state.status])

  useEffect(() => {
    if (readiness.kind === 'loading') return
    if (readiness.kind === 'setup-needed') openSection('models')
    complete()
  }, [complete, openSection, readiness.kind])

  return null
}
