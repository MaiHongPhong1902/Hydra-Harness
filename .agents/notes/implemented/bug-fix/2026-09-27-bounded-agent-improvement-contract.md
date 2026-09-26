# Agent Note: Bounded agent-improvement requests can implement confirmed fixes

Status: implemented

## Problem

The Web surface injected an agent-improvement instruction that allowed one read-only inspection and then required the model to stop. That prevented a direct coding or audit request from reaching the relevant source files and from applying a confirmed fix.

## Decision

Agent-improvement requests now use a bounded evidence-first contract: inspect the directly relevant runtime, code, or session evidence; make the smallest confirmed root-cause change when the user requests implementation; and run one focused check. The contract still forbids unrelated fixture scans and generic category menus, and it asks a question only for a material fact normal inspection cannot establish.

## Alternatives considered

**Keep the one-read stop rule.** This keeps inspection small but makes direct repository fixes impossible when the user does not name one artifact.

**Remove all improvement-specific guidance.** This would permit useful work but loses the bounded-scope and anti-menu safeguards that prevent speculative repository scans.

## Consequences

Concrete improvement requests can now reach their owning source and complete a focused fix while retaining bounded inspection. The Web prompt and its injected first-step message must stay aligned; focused tests pin both paths.
