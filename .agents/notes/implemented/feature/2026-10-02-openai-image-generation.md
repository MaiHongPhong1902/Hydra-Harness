# Agent Note: Image API generation in chat

Status: implemented

## Problem

Users need image API output to appear in agent chat and survive reload and export. A provider's base64 response or temporary URL cannot identify durable session media. Sending generated pixels back through a tool message also depends on conversation-model image support, which is independent of the user's choice of image provider.

## Decision

The OpenAI image tool in [`tool-media`](../../../../packages/media/tool-media/README.md) consumes tools, credentials, and attachments and calls the OpenAI Images API. The base bundle mounts it by default; credential resolution occurs only when a tool is called. Model and credential-reference selection remain independent of the conversation model; the [endpoint routing decision](../architecture/2026-10-02-generative-model-endpoints-and-fallback.md) owns saved provider routes and rejection-only fallback. Requests have configurable prompt, count, byte, and time limits; there is no automatic retry after an uncertain billable outcome.

The Google image tool in the same plugin uses the same services and presentation path for stateless Gemini `generateContent` requests. Its distinct `image_generate_google` tool coexists with OpenAI's `image_generate`; one shared plugin row controls both image tools and video generation live, as described in the [unified media decision](../architecture/2026-10-03-unified-media-generation-plugin.md). Default enablement exposes the tools without depending on a saved plugin toggle, while provider selection and credentials determine whether a requested generation can run. Google credentials use a header rather than a URL parameter. Final inline images require a completed candidate; thought images, provider text, and thought signatures are omitted. Gemini's output count is model-dependent, so the configured count bounds response admission rather than requesting a fixed batch.

The attachment service validates and commits every generated image before the tool settles. Canonical output is `{ model, images }`; Native rendering emits a text acknowledgement and presentation metadata carries `{ kind: 'tool-images', images }`. The shared metadata parser validates durable references without interpreting opaque ids. Session attachment reads and ZIP export include these references. The media result view carries images to the standalone output renderer, whose conversation-owned image callback selects the existing gallery slot. The [media output decision](2026-10-03-standalone-media-generation-output.md) owns placement and animation. The original-image lightbox supplies a native download link and contains keyboard focus.

The [canonical output decision](../architecture/2026-07-20-canonical-tool-output-contract.md), [durable attachment decision](2026-07-22-web-multimodal-image-input-and-durable-attachments.md), and [dynamic attachment ownership](../architecture/2026-08-17-dynamic-client-render-and-attachment-ownership.md) retain their authority. Tool UI images extend presentation metadata without adding model-visible content or session event types. Nested Code Mode dispatch has no persisted metadata; image generation refuses it before issuing a provider request.

## Alternatives considered

**Return image blocks in model-facing tool content.** Rejected because current adapters reject image-bearing tool history and text-only conversation models still need to display generated images.

**Persist provider URLs or base64 in the session.** Rejected because expiring URLs break replay and raw image payloads duplicate the shared attachment store.

**Create a provider registry.** Rejected because image providers retain distinct tool calls within the shared media plugin; saved generation routes are owned by the LLM service. A shared generation capability becomes useful when a non-tool consumer or a provider-independent tool needs implementation selection.

**Add metadata propagation to Code Mode.** Deferred because it changes a shared durable dispatch format and both SDK projections. Refusing the unsupported call prevents paying for an image that cannot appear in the session.

## Consequences

The existing plugin, attachment, and gallery lifecycles own the feature; the agent loop is unchanged. Browser replay exercises a real loop and both providers' HTTP requests against local fixtures, preview, exact-byte download, and reload with both image tools enabled. Focused HTTP tests cover admission, credential rotation, failure, cancellation, and deadline behavior; Google cases also cover thought exclusion, blocked prompts, and incomplete candidates. Live provider access, billing, and native image-generation interaction require separate evidence.

Generation can be billed even when timeout, cancellation, attachment admission, or storage fails. Deployment attachment limits remain authoritative; large PNG output can require JPEG/WebP or an explicit image-byte policy. Image editing and streaming previews are separate API flows. Shared immutable objects remain until reference-aware retention exists.
