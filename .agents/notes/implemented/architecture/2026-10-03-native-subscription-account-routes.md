# Agent Note: Native subscription account routes and transport availability

Status: implemented

## Problem

Fetching a provider's model ids does not establish that Hydra can authenticate its generation or chat protocol. Subscription accounts also require refresh credentials and account selection independently of API-key providers.

## Decision

The account-auth plugin offers Claude, xAI, Kimi Code, Cursor, and Kiro authorization alongside its ChatGPT and Antigravity flows. The [account-pool decision](../feature/2026-09-13-native-account-provider-pools.md) remains authoritative for Host credential ownership, request-local rotation, cancellation, and removal. The [external sign-in decision](../feature/2026-09-14-external-account-sign-in-and-derived-labels.md) retains browser handoff and derived labels. This decision extends provider protocols without replacing either mechanism.

Claude, xAI, and Kimi reuse the installed pi-ai provider factories, OAuth methods, and native streaming APIs. Independent route names retain independent pool records while request dispatch maps back to each SDK provider's native id. The subscription route uses `xai-account` because `xai` belongs to the API-key provider; both can be configured together. OAuth catalog and media calls use the SDK's complete resolved authentication, including header-only Kimi grants. Catalog pagination follows provider cursors and rejects repeated cursors; no catalog request probes generation or fabricates quota.

Cursor uses its browser PKCE polling flow and stores the granted tokens. Its native Connect/protobuf chat implementation is absent. The route remains configurable for account management, but has no callable LLM registration; Settings states this limitation and disables model discovery. The [classification decision](../feature/2026-10-03-model-generation-classification.md) owns its editable catalog. A connected account alone cannot advertise a working model transport.

Kiro uses AWS OIDC device authorization and retains the registered public client's refresh metadata. CodeWhisperer-compatible requests preserve logged system text, history, tool schemas, and tool results. Smithy's maintained event-stream codec owns frame validation. Request deadlines, idle timeouts, cancellation, and reader cleanup belong to the adapter. Unsupported controls fail before network work; metering events without a supported usage projection remain unavailable.

xAI image submissions use JSON and inline bytes, preserving their actual returned MIME type for the shared image consumer. Video submission uses its native JSON job endpoint. Media account rotation applies only to missing credentials or explicit HTTP 401/404/429 rejection; an accepted or uncertain generation never advances to another account.

## Alternatives considered

**Route subscription tokens through a generic OpenAI endpoint.** Rejected because Claude, Kimi, Kiro, and Cursor require distinct authentication or wire protocols.

**Start CLIProxy or a shared Cursor proxy.** Rejected for this native integration: a process-global token getter and checkpoint store cannot safely represent independent Hydra account pools without an additional isolation and lifecycle design.

**Copy all provider SDK implementations.** Rejected because the installed SDK already owns three protocols and their OAuth refresh. Kiro has a separate adapter because its available extension does not expose a compatible standalone provider API.

## Consequences

Settings can manage all seven account routes without passing grants to the browser or adding an agent-loop branch. Cursor account management remains useful while its chat transport is explicitly unavailable. Provider discovery remains entitlement-dependent, and unsupported quota information stays unavailable.

Focused tests exercise OAuth delegation, PKCE, AWS device polling and slow-down, canceled login, locked native refresh, bounded JSON, catalog pagination, native text/tool HTTP requests, event framing, account rotation, and stream cleanup. An assembled Web snapshot owns provider selection, Apply, account persistence, and the Cursor limitation. These fixtures do not establish real provider consent, subscription access, native Electron interaction, or billing behavior.
