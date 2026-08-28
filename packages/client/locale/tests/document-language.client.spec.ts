// @vitest-environment jsdom
/**
 * `<html lang>` tracks the active locale.
 *
 * The served markup declares one language, but the resolved locale may differ
 * (a stored Host preference adopted after activation), and it changes again
 * whenever the user switches. Assistive technology and browser features read
 * this attribute, so a stale value misreports the document language rather
 * than merely looking untidy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@bosch/cordis'
import { SlotRegistry } from '@bosch/bh-client-runtime/client'
import { apply as settingsApply, inject as settingsInject } from '@bosch/bh-client-ui-settings/client'
import { TestRemote } from '@bosch/bh-client-test-runtime'
import { apply, inject } from '@bosch/bh-client-locale/client'
import type { LocaleRuntime } from '@bosch/bh-client-locale/client'
import { LOCALE_SETTINGS_NAMESPACE, LocaleSettingsSchema } from '../src/locale-settings.ts'

/** Boot the plugin over a stub Host settings document. */
async function bench(preference?: string) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  let stored = preference
  let revision = 0
  const namespace = () => ({
    ns: LOCALE_SETTINGS_NAMESPACE,
    schema: LocaleSettingsSchema.toJSON(),
    value: stored === undefined ? {} : { preference: stored },
    applies: 'live' as const,
    secrets: [],
    revision,
  })
  const describeRpc = vi.fn(async () => ({
    rpcId: 'locale-describe' as never,
    result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [namespace()] } },
  }))
  const mutate = vi.fn(async (request: { ops: { value: string }[] }) => {
    stored = request.ops[0]!.value
    revision += 1
    return { rpcId: 'locale-mutate' as never, result: { ok: true as const, value: namespace() } }
  })
  ctx.provide('connection', { api: { settings: { describe: describeRpc, mutate } }, isLoopback: true } as never)
  // The settings transport and the forwarded-event port the plugin injects.
  new TestRemote(ctx)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, locale: ctx.get('locale') as LocaleRuntime }
}

const langOf = (): string => document.documentElement.lang

describe('document language', () => {
  beforeEach(() => {
    // The served markup declares a placeholder; the plugin must not depend
    // on that value already being correct.
    document.documentElement.lang = 'x-served'
    Object.defineProperty(navigator, 'languages', { value: ['fr-FR'], configurable: true })
    Object.defineProperty(navigator, 'language', { value: 'fr-FR', configurable: true })
  })

  afterEach(() => {
    // navigator properties are installed with defineProperty above, so they
    // are removed the same way; nothing here goes through vi.stubGlobal.
    const own = navigator as unknown as Record<string, unknown>
    delete own.languages
    delete own.language
  })

  it('states the resolved locale at activation, not the value the markup shipped', async () => {
    // A browser naming no shipped language resolves en even though the
    // markup shipped a different placeholder.
    const { locale } = await bench()
    expect(locale.getLocale().active).toBe('en')
    expect(langOf()).toBe('en')
  })

  it('follows an explicit Host preference that overrides browser detection', async () => {
    const { locale } = await bench('en')
    await vi.waitFor(() => { expect(locale.getLocale().active).toBe('en') })
    await vi.waitFor(() => { expect(langOf()).toBe('en') })
  })
})
