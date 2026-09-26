# Agent Note: Memory agent durable-input and Browser evidence hardening

Status: implemented

## Problem

Local memory validated write inputs but accepted unbounded or structurally inconsistent durable files on read. Page Memory verified saved anchors while allowing several newer Browser mutation tools to bypass save evidence, and it returned workflows without rechecking saved CSS locators.

## Decision

Local memory rejects documents larger than 32 KiB, more than 100 entries, invalid entry bounds, duplicate identifiers, and invalid timestamps before prompt recall. Secret redaction covers common Bearer, JWT, AWS key, PEM private-key, and provider-token forms. Page Memory records evidence from standard interactive Browser actions, rechecks saved anchors and CSS locators through the Browser state seam before returning verified guidance, and omits query and fragment values from model-visible URLs.

## Alternatives considered

**Trust the durable JSON because the writer enforces limits.** Rejected because files cross a durable boundary and can be edited, truncated, or left by an older version.

**Keep a short allowlist of Browser tools.** Rejected because newly registered interaction tools could silently make verified saves impossible.

**Recheck only page anchors.** Rejected because a stable anchor does not prove that a saved CSS locator still resolves to the intended control.

## Consequences

Malformed or oversized local memory fails closed before it reaches the model, and the local document has a fixed UTF-8 ceiling. Common credential-shaped values are redacted before storage. Local memories remain global to one Hydra home; this change does not add workspace or account partitioning. Page Memory may report Browser verification as unavailable when a saved locator no longer resolves uniquely; the stored workflow remains intact and mutating actions stay blocked until fresh evidence is available. Exact query and fragment text remains part of the private page key but is not repeated in recall messages.

## Testing

Focused personalization tests cover durable-file bounds and credential redaction. Page Memory integration tests cover locator disappearance and successful evidence from coordinate clicks, experimental JavaScript, and PageAgent actions. Native Electron interaction remains a separate verification lane.
