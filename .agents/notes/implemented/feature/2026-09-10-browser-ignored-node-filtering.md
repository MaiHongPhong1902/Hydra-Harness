# Agent Note: Omit explicitly ignored browser nodes from model snapshots

Status: implemented

## Problem

PageController's numbered text snapshot can include nodes that the page explicitly marks as hidden from accessibility or interaction. Sending those lines consumes model context without helping the agent choose a control, especially when a compact result is already bounded by a character cap.

## Decision

`@hydra/harness-tool-browser` filters serialized lines whose tag declaration carries an **attribute named** `aria-hidden="true"`, `role="presentation"`, `role="none"`, or `inert`, before ranking and truncation. The check parses the tag declaration into whitespace-separated tokens and compares attribute *names*, never raw substrings. A rendered attribute value can legitimately contain `data-state=inert`, `href=/docs?role=none`, or `aria-label=aria-hidden=true`, and none of those marks the control as ignored; a substring match on the raw line would have dropped those controls. Only the declaration up to the line's first `>` is parsed, so an element's own visible text — which may contain words like "inert" or "role=" — is likewise never mistaken for a marker. The filter is deliberately conservative: it does not infer decorative content from tag names or remove ordinary non-interactive context. PageController's numeric indexes remain unchanged because the operation removes lines from the model projection and never rewrites the seam's selector map.

PageController emits attribute values unquoted, so a value containing whitespace cannot be distinguished from a following attribute. That residual ambiguity is accepted: the token parser handles the realistic carriers (URLs, `title`/`aria-label` copy, `data-*` state values) without guessing at whitespace inside values.

The preload also asks PageController to include `disabled`, `aria-disabled`, and `href` in its serialized attributes, alongside PageController's own defaults (`role`, `checked`/`aria-checked`, `aria-expanded`, and others). This closes the gap between the accessibility fields the projection is meant to carry — role, accessible name, value/state, disabled/checked/expanded, and href/target — and what was actually reaching the model; `checked`/`expanded` were already covered, `disabled` and `href` were not. `aria-disabled` and `href` surface on indexed controls directly; `disabled` surfaces on custom interactive elements (a delegated listener on a `div`, for example), since PageController excludes a natively disabled `button`/`input`/`select`/`textarea` from the indexed list altogether.

The filter is applied to every model-facing browser state, including full and compact results. Compact action results also retain a per-agent, per-tab normalized-content cache. When the normalized list is unchanged, the result sets `unchanged: true` and omits the repeated list; full reads and changed content still return the existing snapshot. A page that needs hidden content for an interaction can still be addressed through the existing named or indexed seam when that content is present in a later authoritative state; the projection only controls what the model sees.

## Alternatives considered

**Replace the snapshot with a complete accessibility-tree serializer.** This would remove more markup, but it would duplicate PageController's index and action semantics and would make non-compliant pages harder to operate. The current change keeps PageController as the source of element references and leaves broader projection work for measured follow-up.

**Infer decorative nodes from HTML tags or layout.** Tag- and layout-based heuristics can hide useful context and vary across sites. Explicit accessibility and inert markers provide a stable, page-authored signal with a smaller correctness risk.

## Consequences

Model snapshots are smaller when pages emit explicit ignored-node markers or when consecutive compact actions leave the indexed content unchanged. The `unchanged` field is a model-facing result field, while the session log continues to retain the complete tool result. The filter does not yet provide subtree snapshots, changed-line diffs, or trajectory compression; those remain separate changes that require benchmark evidence and replay coverage.
