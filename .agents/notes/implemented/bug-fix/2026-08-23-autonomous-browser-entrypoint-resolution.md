# Agent Note: Autonomous Browser entrypoint resolution

Status: implemented

## Problem

The configured target domain identifies the only permitted website host but not an application route. When approved entrypoint knowledge was absent, the model requested a URL and stopped before calling Browser even when complete testcase knowledge named the required application. The domain root can be a generic platform page that does not link to the required application.

## Decision

The Obsidian-knowledge prompt resolves live navigation without requesting a URL. It prefers a literal same-domain URL from the current conversation, then an approved role entrypoint note. When neither exists, `obsidian_knowledge_read` extracts literal `WorkOn...` application identifiers from complete matched notes and emits bounded, same-domain application-root candidates. The model passes the matching emitted URL unchanged to Browser and accepts it only after live output identifies the expected application or role. It never navigates to the bare configured domain, constructs a deep feature route, or treats database, API, SQL, attachment, or evidence links as UI entrypoints.

Navigation candidates remain ephemeral. After a complete-note read emits candidates, a per-agent host guard denies bare configured-domain navigation and includes the candidates in the tool error so the next model step can correct the call. Candidate state resets at the next turn. Browser evidence must establish the reached UI, and persistence still uses the exact-proposal approval path owned by `obsidian_knowledge_save_approved`. An unreachable feature produces `Blocked` with the observed Browser URL and evidence instead of a request for a link.

## Alternatives considered

**Always navigate to the configured root.** The Bosch OutSystems root is a generic platform page and cannot identify an unlinked WorkON application.

**Search and read the entire vault.** This would bypass the contained `BH Website Knowledge/` read scope and could promote stale or unrelated legacy notes into source evidence.

**Hard-code a WorkON application path.** A package-level route would couple the generic domain-gated plugin to one deployment and would drift when environments or applications change.

## Consequences

Current verification starts Browser without a URL question and can use an application identity already present in complete testcase knowledge. Missing or ambiguous application identity blocks before navigation instead of falling back to the generic domain root. A selected candidate may still fail, but that failure becomes live evidence rather than a guessed route or fabricated result. Approved role entrypoint notes remain the fastest and most reliable path.

## Testing

The package tests pin structured candidate extraction, rejection of a spaced product label as an application identifier, host denial of bare-domain navigation after candidate discovery, the no-question rule, and ephemeral navigation. Browser tool tests separately cover absolute HTTP(S) navigation; a live model run remains necessary to prove tool selection after BH reload.
