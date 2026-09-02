# @bosch/bh-client-ui-settings-plugin-inventory

The local Web Settings contribution for OpenAI/Codex plugin bundles. It registers **Plugins**, **Skills**, **Marketplace**, and **Hooks** tabs in the existing Plugins section. Remote clients only receive the Plugins tab with an unavailable message; local controls are loopback-only.

**Plugins** lists native BH deployment plugins with their enablement controls; protected infrastructure has a visibly disabled switch and cannot be changed. **Marketplace** adds, validates, lists, and removes OpenAI/Codex marketplace sources, imports a selected marketplace plugin into the BH home, and lists, enables, disables, or removes imported bundles. **Skills** lists imported skills. **Hooks** lists imported hook declarations and owns their trust/revoke action. The existing **MCP** tab, contributed by `ui-settings-plugins`, owns imported MCP server enablement and leaves tool approval in the runtime policy.

Marketplace sources accept GitHub shorthand, HTTPS/SSH Git URLs, or local roots. The Host accepts `.agents/plugins/marketplace.json` and root `marketplace.json`. The Settings contribution reads snapshots lazily and only replaces its displayed state with Host operation results.

## Model Experience

None, as this package only visualizes Host-owned plugin state and registers no model-facing input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.
