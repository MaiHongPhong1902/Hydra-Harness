# @hydraharness/harness-llm-account-auth

Native account-backed OAuth routes for ChatGPT and Google Antigravity. The plugin exposes `chatgpt` and `antigravity` as configurable provider routes and stores each provider's accounts in one credentials-service grant record.

The account pool is resolved only when a login, account listing, removal, refresh, or model request needs it. Requests select accounts in round-robin order and retry a later account only when the earlier attempt fails before visible output. Cancellation stops that selection immediately. Access and refresh tokens stay in the Host credential store; authorization surfaces receive account labels and transient login instructions only.

ChatGPT account profiles accept the pi-ai reasoning, cache, transport, timeout, and retry controls. Session-title calls force the provider's cheapest non-thinking mode where the route supports it. Antigravity uses the same stream-idle timeout setting and omits thinking for title calls; ordinary conversation reasoning remains configurable per request.

Provider performance changes follow the [account request policy and verification requirements](../../../.agents/notes/implemented/feature/2026-09-16-account-model-performance.md), including effective setting propagation and the distinction between SDK tests and live latency evidence.

## Configuration and account setup

Enable the provider in Settings, open **Models**, and use the **Account sign-in** section's **Add sign-in provider** action. Select **ChatGPT** or **Google Antigravity** there. API-key provider cards remain available independently; this account flow does not replace or reuse their API-key fields. Complete the provider login in the account flow, then repeat **Add account** for each account that should participate in rotation. Account labels come from the provider identity returned by OAuth, with a stable provider-account fallback when no identity is available.

Choose **Apply** after the accounts are saved. The model selector then lists the models available to the configured provider; selecting one sends later requests through the account pool. Removing an account takes effect on the next request.

The account flow stores provider credentials in the Host credential service and does not start a sidecar or background refresh process. Expired Antigravity access tokens refresh only when a model request or live model discovery needs that account.

The **Account sign-in** list can request provider-reported usage for each account. ChatGPT reports its five-hour and weekly windows plus any banked reset credits when the official usage endpoints return them; Antigravity first reads the Cloud Code Assist quota summary for grouped buckets, reset times, remaining counts, disabled states, and tier credit balances, then falls back to the model catalog when that summary is unavailable. Missing provider fields remain unavailable instead of being guessed, and credentials stay in the Host.

## Model Experience

### Provider request

#### What the model sees

The selected `model` receives the assembled system prompt, message history, tool schemas, and request controls. The account adapter adds no prompt prose; provider replay metadata is removed from every account-backed request so account rotation cannot reuse opaque state.

#### Token effect

Provider tokenization determines exact input and output usage. A failed account attempt is buffered until visible output begins, so discarded failures do not become model-visible history or token usage in the assembled response.

#### KV Cache effect

An unchanged assembled prefix can remain eligible for provider cache reuse. Rotating accounts or changing provider credentials may select a different provider cache, and account-specific replay metadata is therefore omitted from the next request.

### Provider response

#### What the model sees

Provider streams become Harness text, reasoning, tool-call, usage, and finish chunks. The adapter exposes only the first successful account attempt's visible output; an earlier failure with no visible output is discarded before failover.

#### Token effect

The provider's streamed usage is preserved when available. Response blocks enter later model context only after the session records the completed assistant message.

#### KV Cache effect

Recorded response content appends to the next request. Account-backed requests drop provider replay data so one account cannot reuse another account's opaque metadata, including when the next request happens to select the same account.

## Known Limitations and Deferred Work

- **Live provider compatibility depends on account entitlement** — this package has focused transport coverage, but live ChatGPT and Google Antigravity compatibility remains unverified for every account entitlement and model catalog.
- **The model picker uses live discovery when requested** — ChatGPT reads `/backend-api/codex/models` with the connected account token, and Antigravity reads its Cloud Code Assist catalog. The reply is adopted only when the user selects the returned models.
- **The plugin performs no background refresh or workload** — expired access tokens refresh only during the account operation that needs them.
