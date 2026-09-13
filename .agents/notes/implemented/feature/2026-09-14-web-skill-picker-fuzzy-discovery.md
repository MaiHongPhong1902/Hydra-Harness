# Agent Note: Web skill-picker fuzzy discovery

Status: implemented

## Problem

The Web skill picker only accepted a name prefix, so users could not find a skill from remembered letters in the middle of its name.

## Decision

Skill candidates now use case-insensitive ordered-subsequence matching. Exact prefixes rank first; separator boundaries and adjacent characters improve the score, and equal scores keep catalog order. Picking a candidate still inserts the exact skill name, so approximate discovery never changes invocation semantics.

## Alternatives considered

Keeping prefix-only matching preserves the discovery failure. Matching unordered characters or descriptions is unpredictable. A general fuzzy-search dependency adds bundle and ranking behavior for a small catalog, so the existing local scorer is sufficient.

## Consequences

Skill discovery is easier for names such as `commit-helper` while the host still receives the same exact `/name` token. The client test covers case-insensitive subsequences and prefix ranking.
