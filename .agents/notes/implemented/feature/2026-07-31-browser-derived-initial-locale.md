# Agent Note: The Settings language a fresh browser opens in comes from the browser

Status: implemented

## Problem

The Settings Language row opened every first visit in Chinese: `LocaleRuntime` read `bh.locale` from localStorage and fell straight back to `zh` when nothing was stored. The browser already states which languages its user reads — `navigator.languages` is that statement — and the app ignored it, so an English reader met a Chinese product and had to find a Chinese-labelled settings row to escape it. The fallback was doing two jobs at once: the last resort for an unresolvable locale, and the answer for every user who had simply never chosen.

Reading the browser fixed the readers whose browser names a language this app ships, but left the residual case wrong: a browser asking for neither `zh` nor `en` (`fr`, `de`) still fell back to `zh`. Those readers are the least likely to read Chinese.

## Decision

**The provisional locale resolves through the browser, then `FALLBACK_LOCALE` (`en`); an explicit Host preference replaces it live.** `resolveInitialLocale()` in `packages/client/locale/src/client/index.ts` runs at service construction and expresses the browser/fallback order. The nonblocking settings lifecycle then applies optional `locale.preference` from `$BH_HOME/settings.yaml`; absence leaves the browser-derived value active. The [English-only client decision](../simplification/2026-08-27-english-only-client.md) leaves `en` as the sole shipped match, so every supported browser and Host preference converges on English while the ownership and lifecycle stay unchanged.

**One constant serves both the opening locale and the dictionary fallback.** `FALLBACK_LOCALE` answers both "which language does the UI open in when the browser names none we ship" and "which dictionary backs a missing key". `en` is the only shipped locale and each English dictionary is its own typed key source, so the former cross-language parity gate has no pair to compare.

**Browser matching is on the primary subtag, over the ordered list.** `detectBrowserLocale()` walks `[...(navigator.languages ?? []), navigator.language]` and returns the first entry whose primary subtag names a shipped locale, so `en-GB` lands on `en`, while a browser asking only for languages this app does not ship (`fr`, `de`) yields nothing and leaves `FALLBACK_LOCALE` in charge. `navigator.language` trails the list and covers its absence on hosts that ship a Navigator without `languages` — the DOM lib types it as always present, so that tolerance carries a narrow lint exception.

**`window`, not `navigator`, is the browser test.** Node ≥ 21 exposes a global `navigator` reporting the machine's own language, so gating on `navigator` would let a node boot of the client tree resolve to the machine's language instead of the documented fallback. Gating on `window` keeps every non-browser run on `FALLBACK_LOCALE`.

**An explicit choice is durable.** `setLocale` writes the supported `en` choice through the Host settings API, so the preference stays consistent across browser origins and system languages that share the same BH home. Nothing writes the detected locale back: detection is re-derived every boot and stays invisible to the “has the user chosen?” question.

**`<html lang>` follows the resolved locale.** The locale plugin sets `document.documentElement.lang` from the active locale at activation and on a supported selection. The static markup and runtime both declare `en`; the client assignment still prevents an embedder's placeholder value from surviving boot.

**The browser e2e lane pins English and fallback behavior.** `newEnglishPage` advertises `en-US`; the fallback scenario advertises an unshipped language such as `fr-FR` and still reaches the English surface. No assembled scenario depends on a Chinese locale.

## Alternatives considered

- **`Intl.DateTimeFormat().resolvedOptions().locale` or a single `navigator.language` read**: both collapse the user's ordered preference list to one tag, so a `['de', 'en', 'zh']` reader gets zh instead of en. The list is the part of the browser statement worth reading.
- **Persisting the detected locale on first boot**: it would make detection a one-time event and let a stale first visit outlive a changed browser language, and it destroys the distinction the resolution order rests on — a stored value would no longer mean "the user chose this".
- **Full BCP 47 negotiation (`Intl.LocaleMatcher`-style lookup, region and script weighting)**: with exactly two shipped locales that differ in language, primary-subtag matching is the whole of the correct answer; a negotiation layer would be untestable surface with no behavior to justify it.
- **A cordis config key for the fallback locale**: the deployment does not vary here — the fallback is the product's answer for "no signal at all", not a knob. Repo policy reserves `Config` fields for deployment-varying choices with a current consumer.
- **Two constants, one for the opening locale and one for the dictionary fallback**: it separates two genuinely different questions, and would be required if the answers differed. They do not: the dictionaries are symmetric, so both are `en`, and a second constant would be two names for one value plus a rule nothing enforces. The symmetry itself is worth enforcing, so it is gated directly instead.
- **Keeping `zh` as the dictionary fallback while opening in `en`**: it reads as the conservative choice, but with symmetric dictionaries it never resolves a key that `en` would not, so it buys nothing; and where it would matter — a key present only in `zh` — rendering Chinese text inside an otherwise English UI is worse than the bare key a reviewer would notice.
- **Keeping the e2e lane's zh scenarios on storage pinning (`bh.locale=zh`)**: it would keep the suite green while removing the only place the browser-derived path runs in an assembled app; pinning the browser language instead exercises the new resolution end to end.
- **Serving `<html lang>` per request, or leaving the static attribute alone**: computing it server-side would need the request's `Accept-Language` to re-derive what the client resolves anyway, duplicating the rule in two places and still losing to a stored preference the server does not read. Leaving it static is what made the attribute permanently wrong for one language or the other. Setting it from the resolved locale keeps one source of truth.

## Consequences

- Every first visit lands in English. The Language row exposes the single supported option, and unknown stored or requested locale ids receive no compatibility alias.
- Dictionary resolution falls to `en`; TypeScript checks each English dictionary against its own key union, with no cross-language parity gate.
- `<html lang>` reports `en` after locale activation. A client that never activates the locale plugin keeps the served English default.
- Non-browser runs of the client tree open in `en`, and their tests require no browser-language pin.
- Detection cost is one array walk per service construction and no implicit settings write; an explicit Host preference may cause one live convergence after plugin activation.
