# Agent Note: ChatGPT model discovery asks for a client version

Status: implemented

## Problem

"Fetch available models" on a ChatGPT account route failed for every account
with `ChatGPT model discovery failed with HTTP 400`. The listing endpoint
requires a `client_version` query field and refuses a request without one:
`{'type': 'missing', 'loc': ('query', 'client_version'), 'msg': 'Field
required'}`. The harness sent none, so the account's own catalog could never be
read and the route fell back to the catalog installed with the provider SDK.

The field is not only a formality. The endpoint answers with the catalog that
version was released against, and a stale one is answered with a *shorter list
rather than an error*: this repository's own version (`0.1.1-rc.1`) and
`0.82.0` get an empty list, `0.99.0` gets one model, and `1.0.0` gets the
account's current seven. A partial version such as `0.85` is refused outright
with the same 400.

## Decision

Discovery sends a full release version, held in
`CHATGPT_MODELS_CLIENT_VERSION`, and the value names the catalog era the
harness reads rather than the identity of the caller. The live catalog is what
the action exists for, and it is the only source that follows the account: the
installed catalog no longer matches it. At the time of writing the account
served `gpt-6-astra`, `gpt-reserve`, and `codex-auto-review` — none of which the
installed catalog carries — while the installed `gpt-5.3-codex-spark`,
`gpt-5.4`, and `gpt-5.4-mini` entries were no longer reported by the account.

## Alternatives considered

**Send this repository's own version.** Rejected because the endpoint answers it
with an empty catalog, which reaches the page as "the provider listed no
models" rather than as a version problem.

**Send no version and treat the 400 as a signal.** Rejected because the answer
to the missing field is a client-side error with no catalog in it; every fetch
would still fail.

**Serve the installed catalog and skip discovery.** Rejected as the standing
behaviour that hid this: the installed entries drift from the account, so the
selector offers models the account no longer serves and hides the ones it does.

## Consequences

The version is a wire constant that ages: when the endpoint moves its catalog
era forward, this value has to move with it. A stale value fails quietly — an
empty list, not an error — so the value is asserted to be a full release
version in the suite and carries its rationale here rather than in a bare
literal.

## Testing

`packages/llm/llm-account-auth/tests/chatgpt.spec.ts` asserts that the request
carries `client_version`, that the value is a full `major.minor.patch` release
(a partial one is refused by the endpoint), and keeps the discovery projection
covered.
