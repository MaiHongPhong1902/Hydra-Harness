# Agent Note: One English client locale

Status: implemented

## Problem

The browser client carried matching Chinese and English dictionaries, locale-selection behavior, tests, snapshots, and screenshots. Every visible-copy change therefore required two reviewed values even though the current product audience uses English, and the duplicate corpus left stale Chinese references whenever one side changed independently.

## Decision

The browser client ships only `en`. `LOCALE_IDS`, browser detection, Host-backed `locale.preference`, typed dictionary registration, and `<html lang>` remain because they still own one translation seat and the persisted preference API; every product dictionary uses its English object as the key source of truth. Chinese dictionaries, the bilingual parity gate, Chinese-only assertions, and unreferenced `.zh.png` guide screenshots are absent.

The locale runtime still rejects an unknown `setLocale()` id and uses `en` for browser, non-browser, and dictionary fallback resolution. No `zh` compatibility alias converts old values to English; this pre-release repository rejects unsupported persisted settings instead of carrying a second name for the same behavior.

CJK text remains only where the text itself is test data: Unicode width, IME composition, Markdown parsing, wrapping, or the accepted Chinese recommended-label suffix. Frozen archived Agent Notes also remain unchanged. This decision supersedes the bilingual portions of the [full client locale rollout](../architecture/2026-07-30-client-locale-full-rollout.md) and [browser-derived initial locale](../feature/2026-07-31-browser-derived-initial-locale.md); their locale-seat, Host-setting, browser-boundary, and document-language decisions still apply.

## Alternatives considered

**Keep both dictionaries and update Chinese opportunistically.** Rejected because an unchecked second corpus becomes stale product copy, while enforcing parity restores the maintenance cost this simplification removes.

**Map `zh` to the English dictionary.** Rejected because the Language row and persisted setting would advertise a distinction the rendered product does not make.

**Delete the locale subsystem.** Rejected because it owns typed copy injection, common-key fallback, Host preference semantics, reactive label refresh, and `<html lang>`; replacing those services with literals would widen the change and lose established package boundaries.

**Delete every CJK string.** Rejected because Unicode, IME, Markdown, and suffix-parsing tests exercise behavior independent of a shipped locale. Removing their inputs would reduce coverage without removing product language support.

## Consequences

- The Language row contains only English, and a browser language other than English resolves to English.
- Dictionary key completeness is enforced by TypeScript against each `en` object; a cross-language parity gate has no pair to compare and is deleted.
- Existing `locale.preference: zh` data is unsupported and receives no migration shim under the repository's pre-release compatibility policy.
- Reintroducing Chinese requires a real reader need, restored dictionaries and assets, explicit locale registration, and parity verification; an alias is not sufficient.

## Testing

The client TypeScript aggregate detects missing dictionary exports, duplicate object keys, and stale `zh` imports. Locale and GUI tests cover English registration, fallback, Host preference, document language, and component copy. Repository searches separately preserve the intentional CJK test-data cases while rejecting product `zh`, `zh-CN`, `Chinese`, and `中文` references.
