# @hydraharness/harness-research-policy

Research admission policy for native and Code Mode tool calls. It charges search, fetch, and browser attempts to the live delegation root before execution. Descendants share the root's limits; failures and cancellations retain their charge. Durable `research/charge` events preserve cumulative counts across policy reload and session resume. A child with unavailable ancestry fails closed.

## Configuration

All limits are optional positive integers: `maxSearchCalls`, `maxQueries` (distinct queries in each admitted call), `maxFetches`, `maxBrowserCalls`, and `maxDurationMs`. The duration starts at the first research charge and includes idle time; a running cooperative tool receives the remaining deadline. A root session is the budget lifetime. Opening a new root session establishes a new budget; follow-ups and child resumes do not.

The base bundle mounts this policy without limits, so Browser Use and other research tools are not capped by an implicit application setting. Deployments may configure any limits explicitly; those limits are independent of provider-internal native search calls and token accounting. Calls outside an Agent are administrative service operations and are not charged. Exhaustion returns `RESEARCH_BUDGET_EXHAUSTED`; schemas remain visible.

## Model Experience

### Research admission

#### What the model sees

An exhausted tool attempt returns: `Research budget exhausted for this task and its subagents. Use the evidence already collected.` Successful tool output is unchanged. Limits are enforced even when tools are invoked through `run_code`.

#### Token effect

No standing prompt section. A refused attempt adds one ordinary error tool result.

#### KV Cache effect

Append-only tool results; the policy does not change tool schemas or request prefixes.

## Known Limitations and Deferred Work

- Budgets cover model tool dispatch in one host process. Direct service consumers and remote child runtimes require their own admission policy; multi-process writers require durable coordination.
- Charges persist through the ordinary session persistence mechanism. An unflushed crash tail has the same durability limits as other session events.
- Whole-root lifetime limits require a new session for a fresh budget; there is no model-facing reset.
