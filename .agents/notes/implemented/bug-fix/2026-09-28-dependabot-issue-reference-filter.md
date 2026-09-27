# Agent Note: Ignore external references in automated pull request bodies

Status: implemented

## Problem

Dependabot may render these release-note references as HTML anchors as well as Markdown links.

Dependabot release notes contain external pull and issue references such as `actions/cache#1760` and bare `#1775` links. The issue policy parser treated those numbers as Hydra issues and failed the automated dependency pull request before its code checks could finish.

## Decision

The filter removes external HTML anchors before the generic reference scan.

`parseReferences` removes external Markdown links and external `owner/repository#number` references before resolving same-repository issue references. Same-repository issue links and plain `#number` references remain available to the policy validator.

## Consequences

Automated dependency pull requests no longer query unrelated external issue numbers. Human pull requests keep the existing same-repository reference and resolving-status rules.

## Alternatives considered

Exempting Dependabot before parsing would hide malformed same-repository references and leave the parser incorrect for other automated pull requests. Ignoring every numeric reference would break valid plain `#number` issue links.

## Verification

The issue-management tests cover external release-note links, and the updated Dependabot branches rerun the repository checks against the current main base.
