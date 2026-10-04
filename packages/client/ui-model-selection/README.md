# @hydraharness/harness-client-ui-model-selection

Model selection plugin, browser half: TWO entries over ONE per-session directory owned by `ModelDirectoryResolver` (`ctx.modelDirectories`). For ordinary sessions, the `/model` popupSelect contribution (registered through `ctx.commandUi`) and the composer's named `conversation.input.model` seat both load the session's advisory directory through `session.models` and submit through `session.selectModel` via the same `ModelDirectory` instance. The compact composer trigger opens a two-level Model/Effort menu: models stay provider-grouped, while the selected exact model supplies its adapter-owned effort names, descriptions, and default. `/model` applies the selected model's default effort, and the composer can then choose any advertised effort.

When settings are composed, the menu also exposes **Image model** and **Video model** over `llm.models`, filtered by each model's saved image/video endpoint metadata across all providers. Root rows show only the selected model name, retaining its ID when absent from the catalog; drill-in lists group choices by provider. A model marked for both appears in both lists; ordinary models are excluded. Reclassified saved choices remain visible as unavailable until cleared or replaced. These global preferences use the same top-level `llm-pi-ai` settings fields as Settings → Models, with provider/model identity and revision-checked writes. The shared settings mirror synchronizes both surfaces and folds accepted menu writes immediately; failed writes keep the menu open with its durable selection and a visible error. **Automatic fallback** clears the explicit choice. A displayed catalog entry does not establish generation transport or account access.

The Host-reported provider/model/reasoning `ModelSelection` is the single selection fact, but it is echoed only when the exact provider/model pair remains in the advertised groups; an absent catalog row leaves the stored selection intact while the trigger prompts `Select model`, no stale row is synthesized, and no Effort row is shown until the user picks an advertised model. Directory loads and selections share a generation counter so an older response never overwrites a newer one; a connection reset drops every resident projection and repulls the Host-restored selection before display. Provider-local metadata failures list inline while usable groups stay selectable, and selection failures retain the prior selection and directory.

When `session.models.routable` is false, this plugin raises a composer block through `ctx.conversation.blocks` while keeping the model picker available. The Host blocks unserved providers and implicit defaults absent from the visible catalog; explicit or logged selections retain advisory routing. Recovery clears the block without a reload. An unknown client state before the first load or after a failed load does not block; the Host also checks prompt admission.

Directories are per-session, resolved lazily through `ctx.modelDirectories.directoryFor(sessionId)`, and disposed with the session scope. Addressed subagent sessions expose neither entry, and their directory rejects loads, selections, and reconnect refreshes, because ordinary Agent-bound model RPCs would activate persisted child history outside the direct-parent continuation path.

Every resident directory refetches directly on forwarded `llm/adapters-updated` and `settings/document-updated` owner events. Provider topology, provider catalogs, and the default selection therefore converge without the Host or client runtime deriving a separate model-change alias.

The `/client` exports are the plugin body (`apply`/`inject`), `ModelDirectoryResolver`, `ModelDirectory` with its state fields, and the seat's injected face type.

## Model Experience

Indirectly, through the `session.selectModel` RPC available to ordinary sessions, both entries submit the complete `ModelSelection` that the Host snapshots at the next prompt-assembly boundary, so the following request uses the selected provider, model, and effort while a running step keeps its assembled selection; the selection becomes durable only when the existing request header records a request that consumes it, and menu interaction adds no prompt content.

#### KV Cache effect

Switching the route can reduce or invalidate provider-side cache reuse for subsequent requests; the prompt prefix itself is untouched.

## Known Limitations and Deferred Work

- **No create-time or addressed-subagent selection** — both entries require an existing ordinary session's Agent; there is no draft-phase model choice to fold into session creation, and subagent continuation deliberately exposes no independent model-selection contract.
- **Directory names are presentation-only** — selection and persistence use provider/model/effort ids; a provider whose catalog or exact-model metadata lookup fails lists as an unselectable failure row until reload.
- **No arbitrary effort input** — the composer offers only the exact model's adapter-advertised levels; an adapter without reasoning metadata leaves the Effort row absent.
