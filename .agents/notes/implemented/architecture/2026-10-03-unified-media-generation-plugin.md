# Agent Note: One plugin controls image and video generation

Status: implemented

## Problem

Provider-specific image plugin rows make one media capability require several switches. Video output also needs an actual generation consumer that turns accepted jobs into durable playable files while preserving the selected provider's credentials and rejection-only fallback.

## Decision

[`tool-media`](../../../../packages/media/tool-media/README.md) owns one plugin fiber and registers the existing OpenAI-compatible and Google image tools together with `video_generate`. Provider-specific configuration is nested under `openai`, `google`, and `video`; helpers register directly in the owning fiber, so no hidden child plugins appear in inventory. One Settings switch and disposal remove every media tool together. This grouping supersedes the separate plugin ownership in the [image presentation decision](../feature/2026-10-02-openai-image-generation.md), while retaining its durable references, billing guards, and Native-only execution rule.

The video tool consumes the existing configured generation routes and global video selection. An explicit `pollIntervalMs` asks the provider adapter to complete the accepted video job. Native Veo uses `predictLongRunning`; xAI and compatible Videos API jobs retain their own submission formats. The accepted route, credential, headers, and proxy are captured through polling and download. Neither status errors nor download failures enter generation fallback. Delivery URLs are restricted to the original origin or provider CDN hosts, and foreign origins receive no route credentials. The tool streams the completed MP4/WebM into the attachment service with a deployment-configured byte limit; durable metadata supplies the existing video renderer and export path.

The selected conversation model refines media prompts through the tools' prompt descriptions during its ordinary turn. Image terminology covers composition, framing, lighting, materials, and style; video terminology also covers camera and subject motion and timing. Refinement preserves user intent, exact quoted text and language, counts, exclusions, and requested generation parameters, and an explicit request to skip rewriting takes priority. The executor forwards the authored prompt unchanged. Original input and final prompt are both durable, and the existing media card supplies inspection and copy actions.

## Alternatives considered

**Group provider rows only in the Settings UI.** Rejected because runtime enablement would still have several independently disposable owners and configuration rows.

**Mount the old plugins as children of a bundle plugin.** Rejected because inventory would still expose provider plugin rows and their switches.

**Poll provider jobs inside the generic tool using provider keys.** Rejected because saved routes own protocol, OAuth, headers, and network proxy; reconstructing authentication in the consumer risks switching credentials after a job is accepted.

**Automatically choose a video provider or resubmit failed jobs.** Rejected because video selection belongs to the user and an accepted generation can remain billable when polling or download fails. Public Sora is not a default because OpenAI removes its API on 2026-09-24.

**Rewrite prompts through a separate model call inside the executor.** Rejected because the selected conversation model already authors the tool call with the session context. An additional call adds latency and usage, and hides the provider's actual prompt from the logged tool call and media card.

## Consequences

Image tool names and durable presentation remain stable, while configuration and package ownership converge on one media plugin. Video generation requires a configured endpoint-compatible model and its credentials. Deployment controls polling interval, total deadline, metadata bytes, and downloaded bytes. The attachment store keeps exact file bytes without decoding; provider availability, video validity, billing, and native Desktop interaction require separate evidence from local HTTP and browser replay.

Focused HTTP tests cover job completion, no resubmission after acceptance, cancellation, bounded storage, and authentication isolation. The assembled Web scenarios exercise one inventory row and switch, image generation, video playback, download, history reload, and export with local provider fixtures. The shared image presentation decision retains image admission and gallery verification.

The assembled media replay pins the prompt descriptions received by the conversation model and verifies that its authored video prompt reaches the provider with matching duration and size while the original input remains in history. Replay establishes instruction delivery and routing, not a live model's adherence or an improvement in generated media quality.
