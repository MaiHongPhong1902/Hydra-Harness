# Agent Note: Independent Web Search provider selection

Status: implemented

## Problem

Search selection tied to a shipped DeepSeek registration cannot express an unconfigured installation or a user's choice of a separate search service. Provider-specific Settings controls also duplicate metadata and lose drafts if their lifetime follows the selected card.

## Decision

The existing [web service](../../../../packages/web/web/README.md#product-search-settings) owns saved search selection, descriptors, and connection probes. The base bundle requires explicit selection; the tool keeps its common `web_search` name and arguments. Chat model changes do not write search preferences. Product search never tries another provider after a failure.

An explicit legacy DeepSeek search section initializes selection. An ambient chat key is insufficient evidence. Persisting an empty selection marks a fresh installation as initialized, so later provider edits cannot accidentally trigger migration. Standalone compositions retain their explicit provider and fallback configuration.

DeepSeek owns its existing Messages adapter. [Serper and Other](../../../../packages/web/web-search-http/README.md) share HTTP transport and dot-path mapping while retaining independent settings and credential references. Descriptors advertise only implemented search types and carry the controls consumed by the client. Provider exceptions expose owned diagnostic text; credentials and raw responses stay out of tool results. Credentialed HTTP requests reject redirects before another destination is contacted.

The [Web Search Settings controller](../../../../packages/client/ui-settings-plugins/README.md) retains a form for every provider. Save captures all drafts before any write and activates the selected provider after provider writes succeed. Edits made during Save remain staged. Connection tests use saved configuration and discard stale replies after an edit. Credential writes use their acknowledgement, independently of configured-state reads.

Country and language belong to each search request. The agent interprets the requested location, market, and language; the tool validates and forwards optional codes. Fixed Settings defaults would bias unrelated tasks toward the same locale. Prompt language alone is insufficient evidence of a country, so unspecified hints are omitted. Other keeps only the request-field mappings needed by its endpoint.

## Alternatives considered

**A second provider manager and provider-specific tools.** Rejected because `ctx.web` already owns registration and execution. Another registry duplicates routing and disposal; separate tools couple the agent's schema to installed providers.

**Infer search selection from the chat key or model.** Rejected because having a chat credential does not authorize spending through that vendor's search endpoint. An explicit unselected value also survives later configuration changes.

**Automatically try another provider.** Rejected for product Settings because failure would silently change the destination and cost. Explicit standalone fallback remains a separate deployment choice.

**Probe unsaved configuration.** Rejected because it needs another secret-bearing request path and makes the tested configuration differ from the next tool call. Save precedes the real search probe.

**Fixed country and language defaults.** Rejected because search geography follows the task, not installation location or a previous query. Agent-provided hints remain logged tool arguments and require no extra model call or locale classifier.

## Consequences

Provider and credential namespaces commit separately. A failed Save can leave accepted provider fields persisted, but retains failed drafts and does not activate the pending selection. There is no cross-file rollback transaction. Adding a provider requires its registration and descriptor; the UI consumes the same metadata.

URL comparison strips fragments and tracking parameters while preserving non-root trailing slashes, which can identify different resources. Search types beyond web, automatic aggregation, and reranking remain unsupported.

## Verification

Focused checks cover live selection, migration markers, credential writes, cancellation, redirect refusal, mapping validation, bounded JSON, and registration disposal. The assembled Web scenario drives Settings, a real local search endpoint, credentials storage, and the agent-scoped tool, with keyless UI and tool-output snapshots. The DeepSeek browser scenario exercises the existing adapter independently.

## Related

The [web capability decision](../architecture/2026-06-24-web-capability-seam.md) retains ownership of the Service Definition / Provider / Consumer split. [Desktop browser settings](2026-08-26-desktop-browser-settings.md) owns browser policy; Web Search has its own Settings section. [Public web research](2026-09-07-public-web-research.md) retains public-fetch protection and explicitly configured standalone fallback.
