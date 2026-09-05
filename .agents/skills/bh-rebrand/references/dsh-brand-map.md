# DSH brand map

Checked against `C:\Users\map7hc\Desktop\DSH\deepseek-harness` on 2026-09-03. This checkout has layered branding; do not treat it as one global string replacement.

## Current fingerprint

| Layer | Current identity | Source evidence |
| --- | --- | --- |
| Desktop shell | `WorkON`, `WorkON Host` | `apps/desktop/main.cjs` |
| Product/ecosystem | `Bosch Harness`, `BH`, `BH Local Build`, boot word `HARNESS` | README, CLI/Web copy, PWA metadata, client title/boot page |
| Provider display | `DeepSeek`, `DeepSeek-V4-*` | DeepSeek adapter catalog and provider metadata |
| Visual mark | WorkON W; primary `#0096E8`, dark `#006EAD` | React SVG primitives, sidebar wordmark, favicon |
| UI accent | `rgb(0, 150, 232)` with light hover `rgb(0, 110, 173)` | `ui-theme/src/styles/design-platform.css` |
| Voice | Technical and direct: plugin-based, open, reusable, composable | README and onboarding copy |

`BRAND_GUIDELINES.md` is the live policy source. Do not infer endorsement, invent brand assets, or weaken trademark/attribution language.

## Cheap anchor check

Run from the Git root. No output means the map's primary owners still exist.

```powershell
@('BRAND_GUIDELINES.md','apps/desktop/main.cjs','apps/web/index.html','apps/web/public/manifest.webmanifest','apps/web/public/favicon.svg','packages/client/ui-renderer/src/client/DocumentTitle.tsx','packages/client/web/src/boot-page.ts','packages/client/ui-primitives/src/FishLogo.tsx','packages/client/ui-primitives/src/BrandWordmark.tsx','packages/client/ui-brand-official/src/client/Brand.tsx','packages/client/ui-sidebar/src/client/WorkOnLogo.tsx','packages/client/ui-theme/src/styles/design-platform.css','packages/llm/llm-deepseek/src/index.ts','packages/llm/llm-deepseek/src/adapter.ts','packages/web/web-search-deepseek/src/index.ts','packages/client/ui-settings-models/src/client/locales.ts','packages/client/ui-settings-plugins/src/client/locales.ts','packages/client/connection/src/client/fixture.ts') | Where-Object { -not (Test-Path -LiteralPath $_) }
```

## Owners by lane

| Lane | Read/edit first | Follow-on surfaces |
| --- | --- | --- |
| Desktop identity | `apps/desktop/main.cjs` | Its inline smoke assertions and `apps/desktop/package.json` metadata |
| Web/PWA identity | `apps/web/index.html`, `apps/web/public/manifest.webmanifest`, `packages/client/ui-renderer/src/client/DocumentTitle.tsx`, `packages/client/web/src/boot-page.ts` | `apps/web/tests/pwa-manifest.e2e.ts`, `apps/web/tests/assembled-boot.ts`, `packages/client/ui-renderer/tests/document-title.client.spec.tsx`, built-boot snapshots |
| Visual identity | `packages/client/ui-primitives/src/FishLogo.tsx`, `BrandWordmark.tsx`, `packages/client/ui-brand-official/src/client/Brand.tsx`, `packages/client/ui-sidebar/src/client/WorkOnLogo.tsx` | `apps/web/public/favicon.svg`, sidebar/hero fallbacks, `ui-primitives` icon tests, `ui-brand-official` and sidebar tests/snapshots |
| Brand composition | `packages/client/ui-brand-official/src/client/index.ts`, `packages/bundle/web-app/cordis.patch.yml` | Slots `sidebar.brand.mark`, `sidebar.brand.name`, `conversation.hero.brand.mark`; keep these slot IDs stable for display-only work |
| Theme | `packages/client/ui-theme/src/styles/design-platform.css` | `docs/web-styling.md`, theme tests, representative light/dark UI |
| Product copy | `README.md`, `packages/client/ui-settings-models/src/onboarding-copy.ts`, `apps/cli/src/args.ts`, `apps/cli/config/agent-presets/cordis/agent.cordis.yml`, `packages/bundle/web-app/src/startup.ts`, `packages/bundle/web-app/src/index.ts` | Corresponding tests, current docs, package descriptions, website projection |
| DeepSeek provider display | `packages/llm/llm-deepseek/src/index.ts`, `packages/llm/llm-deepseek/src/adapter.ts`, `packages/web/web-search-deepseek/src/index.ts`, `packages/client/ui-settings-models/src/client/locales.ts`, `packages/client/ui-settings-plugins/src/client/locales.ts`, `packages/client/connection/src/client/fixture.ts` | package and settings docs, Web/search/client/API/SDK/replay fixtures, model-selection and onboarding tests, and Web snapshots |

The visual mark exists in three formats that must stay synchronized when its geometry or colors change: `FishLogo.tsx`, the mark embedded in `WorkOnLogo.tsx`, and `apps/web/public/favicon.svg`. `BrandWordmark.tsx` owns the separate official name artwork. The official build fills generic brand slots through `ui-brand-official`; non-official builds can show sidebar/hero fallbacks.

## Focused discovery

Run only the command for the selected lane. These list candidate files without loading their contents.

```powershell
rg -l 'WorkON|WorkON Host|Bosch Harness|BH Local Build|\bHARNESS\b' apps/desktop apps/web packages/client/web packages/client/ui-renderer packages/client/ui-settings-models packages/bundle/web-app apps/cli README.md
rg -l 'FishLogo|BrandWordmark|WorkOnLogo|#0096E8|#006EAD|rgb\(0, 150, 232\)|rgb\(0, 110, 173\)' apps/web packages/client
git grep -l -I -E 'DeepSeek|BHAgent' -- packages/llm/llm-deepseek packages/llm/llm-pi-ai/tests packages/llm/llm/tests packages/web/web-search-deepseek packages/client/connection packages/client/runtime packages/client/ui-model-selection packages/client/ui-settings-models packages/client/ui-settings-plugins packages/host/apiproxy/tests packages/sdk/server/tests packages/test-support/llm-replay/tests apps/web/tests .agents/notes/implemented
```

For a full product-copy rename only after the owner pass, widen the first search to `docs website packages --glob '!**/lib/**' --glob '!**/dist/**'`. Search snapshots after source/fixture changes, not before.

## Preserve by default

- DeepSeek transport/provider contracts: `deepseek-official`, `deepseek-v4-*`, `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `api.deepseek.com`, `llm-deepseek`, DeepSeek class names, upstream-specific error text, and real-API tests.
- BH development contracts: CLI `bh`, `BH_*`, `@bosch/bh-*`, repository URLs, slot IDs, `--dsw-*`, and historic exports such as `FishLogo`.
- Legal and provenance: `BRAND_GUIDELINES.md`, licenses, third-party notices, vendor content, archived notes, and historical changelogs.
- Generated output: do not edit `lib/`, `dist/`, or build caches directly; rebuild them. Update committed snapshots only through the owning test workflow.

An explicit full technical rename overrides this list, but then inventory configuration, persisted data, package consumers, scripts, docs, and migration impact before changing identifiers.

## Provider and browser split

`DeepSeek` is the LLM and Web search provider display. `BHAgent` is independently the built-in browser control actor and `bhagent` is its destination id. For provider-only work, preserve `BHAgent` in these owners and their tests:

- `.agents/notes/implemented/feature/2026-08-26-desktop-browser-settings.md` and `docs/subsystems/browser.md`
- `packages/browser/browser-electron/README.md`, `electron-app/main.cjs`, `src/{child,index}.ts`, and `tests/{electron,settings}.spec.ts`
- `packages/client/ui-layout/src/client/{BrowserSection,DesktopBrowserPanel}.tsx`, `browser-locales.ts`, and `tests/browser-settings.client.spec.tsx`

Use `git grep -n -I -i 'BHAgent'` for a tracked-source residue audit. Do not use `BH[ _-]*Agent`; it catches the unrelated `@bosch/bh-agent` technical package family.

## Smallest verification set

- Visual lane: `pnpm exec vitest run packages/client/ui-primitives/tests/icons.client.spec.tsx packages/client/ui-brand-official/tests/browser-plugin.client.spec.tsx packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx`.
- Provider-display lane: start with `pnpm exec vitest run packages/llm/llm-deepseek/tests/adapter.spec.ts packages/llm/llm-deepseek/tests/dynamic-config.spec.ts packages/llm/llm/tests/topology.spec.ts`; add only changed client/API-proxy tests.
- Web/PWA or onboarding: rebuild affected client/Web artifacts, then run the matching file with `vitest.web.config.ts` and inspect the visible surface when available.
- Docs/copy: run the relevant doc gate named in `package.json`; always run `git diff --check`.

End with the same focused search using the old display literals. A provider rename must leave no `BHAgent-V4-*`; every remaining contiguous `BHAgent` occurrence must belong to the browser list above or an Agent Note that explains this split. Expected technical DeepSeek/BH identifiers are not residue.
