# Web UI style reference

This reference defines styling ownership and component rules for browser client packages. The current token values live in [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/); this document does not duplicate that generated-by-source inventory.

## Ownership

[`ui-theme`](../packages/client/ui-theme/README.md) owns the `--dsw-*` static scale, semantic aliases, typography, motion, gradients, shadows, scrollbar styles, and light/dark preference. [`ui-layout`](../packages/client/ui-layout/README.md) applies the resolved theme snapshot to the document. Feature packages consume semantic aliases and do not define another global theme.

Global style sheets belong in `ui-theme/src/styles/`. Component styles live beside their component as CSS Modules. A component may define a local custom property when its value is part of that component's layout or presentation contract; shared colors, typography, elevation, and motion belong to the theme package.

## Component rules

- Use CSS Modules and `clsx`; do not add a component library or Tailwind.
- Use `--dsw-alias-*` semantic tokens in feature components. Do not copy static palette values or write literal colors there.
- Keep theme selectors out of feature component CSS. Light/dark overrides belong to the theme owner.
- Pair font sizes with line heights and use the theme typography variables when an existing role matches.
- Keep source text, terminal output, and diff lines unwrapped when their component contract requires column preservation; use the shared scrollbar styles rather than component-specific scrollbar selectors.
- Put presentation in CSS. Inline React styles may pass component-local custom-property values but must not encode theme branches.
- Preserve keyboard focus visibility and reduced-motion behavior when adding transitions or hover-only controls.

## Form controls and dropdowns

Native text inputs, selects, textareas, and value-picker buttons declare `data-hydra-control`. [`controls.css`](../packages/client/ui-theme/src/styles/controls.css) owns their border, fill, radius, typography, and interaction states. Feature CSS owns width, flex layout, textarea extent, and space reserved for an adjacent icon; it must not redefine the shared chrome.

| Value | Use |
|---|---|
| `field` | Settings and dialogs: minimum 32px height, 14px/22px text. |
| `compact` | Toolbars, composer pickers, and panel filters: minimum 28px height, 12px/18px text. |
| `embedded` | An input inside a `field` or `compact` wrapper, including the shared `Input` primitive. The wrapper owns focus, disabled, and invalid styling. |
| `editor` | Textareas whose editor owns glyph measurement, mirrored highlights, or bubble layout. Preserve their editor styling and keyboard behavior. |
| `action` | A menu trigger that performs actions rather than selecting a value. Keep its button styling and accessible name. |

Checkboxes, radios, file pickers, sliders, color pickers, hidden inputs, and submit/reset buttons keep their native or existing primitive styling. Every other native field must choose a supported role; `pnpm run verify-ui-controls` checks production TSX during `doc-sync` and CI. The gate checks declarations, while review checks that `editor`, `embedded`, and `action` match the control's actual purpose.

Use native `select` for simple choices. Keep its native arrow and platform popup; do not draw a second arrow. Rich menus use the shared `Menu` or an existing specialized picker, with `aria-haspopup`, `aria-expanded`, Escape dismissal, and keyboard-operable items. Popup surfaces consume the menu fill, panel radius, inverted border, and level-three shadow tokens.

Associate each field with a label or accessible name. Link explanatory or error text with `aria-describedby` when needed; report invalid values through `aria-invalid` and visible text, not color alone. Shared controls retain a visible keyboard focus ring, use native `disabled` for unavailable input, and keep read-only values legible. Validate both themes and narrow layouts with the real assembled browser UI; do not replace native editing behavior to achieve visual consistency.

## Changing the system

Add or change a shared token in the owning `ui-theme` sheet, then consume its semantic alias from feature packages. Update the owning package reference when a public styling contract changes. Visual behavior follows the [testing policy](testing.md); the [styling-system Agent Note](../.agents/notes/implemented/process/2026-07-19-web-styling-system.md) records framework rationale.
