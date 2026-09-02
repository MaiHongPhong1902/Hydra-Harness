# @bosch/bh-client-ui-settings-personalization

Settings → Personalization section (nav order `1`): custom instructions, memory status, and the personality selector. Registers `settings.section` (`id: 'personalization'`) using [`ui-settings`](../ui-settings/README.md)'s existing slot, `ctx.settingsScope`, and locale contracts — this package owns no shell chrome.

- **Custom instructions** load and save through the personalization RPC pair (`settings.readInstructions`/`writeInstructions`, [`@bosch/bh-host-apiproxy`](../../host/apiproxy/README.md)), which stores the document at `$BH_HOME/AGENTS.md`. The editor's `expectedRevision` fences writes against the document's SHA-256 content hash; a stale write surfaces as a distinct `conflict` status with a reload affordance, never a silent overwrite.
- **Memory** shows a fixed unavailable message. No memory engine exists in this deployment yet; this is not a disabled toggle or a stubbed setting, just a status line.
- **Personality** is an ordinary settings namespace (`personalization`, owned host-side by [`@bosch/bh-personalization`](../../context/personalization/README.md)) bound through `ctx.settingsScope.bind()`, identically to any other settings-backed preference row in this app.

## Model Experience

Indirectly, through the custom-instructions document and personality value this section edits — `@bosch/bh-agent-instructions` and `@bosch/bh-personalization` own their model-visible rendering.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No live multi-tab invalidation for custom instructions** — unlike a namespace-registered settings section, a write here does not ride the forwarded `settings/document-updated` event. A second open tab discovers a concurrent edit only on its next save attempt (`instructions-conflict`) or a manual reload of the section.
- **No client-side size or format validation** — the editor accepts any text; the 65,536-byte UTF-8 cap and content-hash revisioning are enforced entirely Host-side. An oversized draft is rejected only on save.
- **Memory has no settings-backed configuration** — the section intentionally renders no toggle, since a fake control would misrepresent a capability that does not exist. Add one only alongside a real memory engine.
