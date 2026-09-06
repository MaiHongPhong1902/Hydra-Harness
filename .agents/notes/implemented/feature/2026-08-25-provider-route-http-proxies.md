# Agent Note: Provider route HTTP proxies

Status: implemented

## Problem

Some provider endpoints are reachable only through a forwarding proxy, but process-wide proxy environment variables would redirect unrelated provider routes and could race between simultaneous requests. The Models page also interrogates a draft endpoint before it is stored, so a proxy field that only reaches streaming requests would leave **Fetch available models** unable to reach the same endpoint.

## Decision

`llm-deepseek` and every `llm-pi-ai` provider profile accept an optional `proxy` URL with an `http:` or `https:` scheme. The Models page exposes the same field for configured and custom providers; its draft interrogation forwards it through the host contract.

`@hydra/harness-llm/proxy` owns the Node-only per-request transport helper. Direct DeepSeek fetches use its proxy dispatcher, while pi-ai stream construction runs in an async request context so SDK-created fetches inherit only the selected route's proxy. The helper stays on a separate package export rather than the browser-consumed `@hydra/harness-llm` root entry.

## Alternatives considered

**Process-wide `HTTP_PROXY` and `HTTPS_PROXY` mutation.** This would make a configuration edit affect every route and would let concurrent route requests overwrite each other.

**A proxy only for the Models page.** Discovery would work, but the first real model request would bypass the operator's network route.

**Separate adapter-specific proxy implementations.** Two copies would need to maintain the same validation, credential-safe diagnostics, and route-isolation behavior.

## Consequences

One configured route can use a corporate or local forwarding proxy while its peers remain direct or use different proxies. An absent or whitespace-only proxy stays direct. Non-empty proxy URLs are validated when profiles resolve, and validation errors do not echo a raw URL that could contain credentials. Proxy agents are reused per configured URL; the small route-owned cache has no eviction because provider profile churn is expected to remain low.

The feature supports HTTP(S) forwarding proxies only. SOCKS and a process-wide proxy policy remain outside this provider configuration surface.

## Testing

Focused UI tests cover saving and probing the field for both card families. Adapter tests confirm blank values stay direct and use a local CONNECT relay to confirm a DeepSeek stream, a custom pi-ai stream, and simultaneous pi-ai routes traverse their configured proxy; host contract tests cover forwarding and error redaction.
