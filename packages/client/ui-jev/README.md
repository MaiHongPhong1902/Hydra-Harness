# `@hydra/harness-client-ui-jev`

Optional browser contribution to Settings → Models. Enable the Jev group in Plugins and save to mount both the Host provider and this UI contribution. The Add provider dropdown then contains `Jev`; selecting it opens a write-only API-key field and the Host's resolved model label. Apply writes through the existing Credentials API using the Host's configured credential reference. The draft lives only in component memory and is cleared after acknowledgement; settings and browser persistence contain no secret.

The contribution uses the Models page's `settings.models.provider-option` slot and disappears with the plugin. Once the Host confirms a configured credential, Jev appears in the API keys provider list with a configured indicator and an Edit action. The row survives page reloads and follows credential updates; Edit opens a blank, write-only key field. It does not add Jev to the conversation model picker or the Host LLM provider directory.

## Model Experience

### Provider configuration

#### What the model sees

The UI registers no model-facing text. It configures the independent `ctx.jev` capability; the separate browser-decisions plugin owns its model-facing tool.

#### Token effect

Zero; opening the editor and saving a credential make no model request.

#### KV Cache effect

The conversation prefix and model route are unchanged by credential edits.

## Known Limitations and Deferred Work

- The card exposes the resolved model label; endpoint and model editing remain Host configuration concerns.
- No network request runs when the card opens.
