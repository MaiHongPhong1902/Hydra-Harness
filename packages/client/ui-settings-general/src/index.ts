/** Host loader entry for the browser implementation exported from `./client`. */

import type { Context } from '@hydra1902/cordis'
import z from '@hydra1902/schemastery'
import { settingsNamespace } from '@hydra1902/harness-settings'

/** Durable settings namespace for product-wide GUI onboarding facts. */
const ONBOARDING_SETTINGS_NAMESPACE = 'ui-onboarding'

interface OnboardingSettings {
  /** Last version acknowledged by the current product welcome step. */
  welcomeNoticeVersion?: string
  /**
   * Whether the user dismissed the shipped official DeepSeek Models row.
   * The adapter stays mounted; its row, model catalog, and first-run prompt stay hidden
   * until the user adds that route again.
   */
  deepseekOfficialDeclined?: boolean
}

const OnboardingSettingsSchema: z<OnboardingSettings> = z.object({
  welcomeNoticeVersion: z.string(),
  deepseekOfficialDeclined: z.boolean(),
})

/** Register the durable GUI-onboarding section when a settings provider exists. */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(ONBOARDING_SETTINGS_NAMESPACE),
      OnboardingSettingsSchema,
    )
  })
}
