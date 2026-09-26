# Agent Note: Isolated benchmark CDP approval

Status: implemented

## Problem

Browser benchmark tasks can need the browser CDP tools, but the normal approval policy waits for a human decision. An unattended batch can therefore wait until its task timeout. A global approval change would alter unrelated Hydra sessions.

## Decision

The browser tool plugin accepts `enableCdpTools`, which defaults to enabled when the browser service grants full CDP access, and `autoApproveCdp`, which defaults to disabled. When the latter is enabled in a scoped composition, the approval waterfall grants `allowed-once` only to `browser_cdp_*` requests and delegates every other tool to the existing policy. The benchmark preset enables both options; the runner still audits browser-only calls and preserves the session evidence.

## Alternatives considered

**Disable CDP for benchmark tasks.** This removes the approval wait but prevents tasks that need CDP inspection.

**Change the global approval policy.** This would grant benchmark-specific permission to normal Hydra sessions.

**Auto-approve every tool in the benchmark.** This grants more authority than the browser capability requires and weakens the tool audit.

## Consequences

The preset must be reloaded by restarting Hydra before new sessions use the setting. Normal sessions keep their existing approval behavior, and CDP remains limited by the browser service and recorded in the task evidence.
