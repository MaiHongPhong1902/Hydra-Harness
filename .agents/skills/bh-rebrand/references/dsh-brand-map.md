# Hydra harness brand map

## Current identity

The product and browser actor display `Hydra harness`. DeepSeek identifies the external provider. The logo is the supplied blue, three-headed pixel-art Hydra, preserved in `assets/branding/hydra.png`.

## Owners

| Surface | Source | Derivatives or checks |
| --- | --- | --- |
| Artwork | `assets/branding/hydra.png`, `scripts/gen-brand-assets.py` | Embedded client PNG, app/site favicons, website wordmark, desktop/browser icons, badge |
| React identity | `packages/client/ui-primitives/src/HydraLogo.tsx`, `BrandWordmark.tsx` | Official brand plugin, sidebar brand, conversation hero; `icons.client.spec.tsx` |
| Desktop | `apps/desktop/main.cjs` | Window title and icon, smoke assertions, package publication files |
| Web | `apps/web/index.html`, `apps/web/public/manifest.webmanifest` | `DocumentTitle.tsx`, `boot-page.ts`, built boot and PWA tests |
| Browser actor | `packages/browser/browser-electron/electron-app/main.cjs`, `chrome.html`, `src/child.ts` | Browser settings copy in `packages/client/ui-layout` and browser package tests |
| Documentation site | `website/.vitepress/config.ts`, `website/docs.ts`, `docs/user/index.md` | `docs:check`; generated `website/.generated` and `.dist` stay disposable |
| Badge | `packages/skill/skill-badge/assets/hydra-badge.md`, `src/index.ts` | `hydra-badge.png`, package test, `apps/cli/tests/hydra-badge.snapshot.ts`, Cordis tutorial |
| Provider | `packages/llm/llm-deepseek`, `packages/web/web-search-deepseek` | Provider catalogs, settings, API fixtures; keep DeepSeek display names |

Regenerate artwork with `uv run --with pillow python scripts/gen-brand-assets.py`. See [artwork ownership](../../../../assets/branding/README.md).

## Verification

Run the matching existing suites for `ui-primitives`, `ui-brand-official`, `ui-sidebar`, `ui-layout` browser settings, and `skill-badge`. Refresh the badge's keyless assembled snapshot after instruction changes. Rebuild with `pnpm run build`, then run built Web boot/PWA tests and the desktop smoke. Documentation uses `pnpm run docs:check` and `pnpm run doc-sync`.

Search old display literals only in owned current source and docs, excluding dependencies, generated output, and archives. `BRAND_GUIDELINES.md`, upstream repository/community links, historical postmortems, and external WorkON application examples describe their own subjects; do not relabel them as Hydra. `bh`, `BH_*`, `.bh`, `bhagent`, IPC/service keys, and upstream User-Agent/wire values are technical identifiers.
