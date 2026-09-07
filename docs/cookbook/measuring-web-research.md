# Measure web research from session logs

Use this procedure to compare research behavior with the same model, task, and source set. The report runs locally and does not send transcript content to a collector.

1. Run these tasks in separate fresh root sessions: read a known documentation URL; discover a current release and read its official notes; compare two sources for one claim; read a page requiring JavaScript; and ask delegated researchers to share a limited search budget. Keep the exact prompts and source versions with the results.
2. Export each canonical session as JSONL. Include child-session logs when comparing the complete delegation tree.
3. Run `pnpm research:report root.jsonl child.jsonl`. The report pairs native and Code Mode tool calls, excludes inherited fork prefixes, and reports recorded duration, errors, output characters, model requests, and provider-reported tokens. Missing timestamps remain `null`; token totals include only reported usage. It does not invent monetary cost or hidden provider search counts.
4. Compare repeated runs using median task latency, search/fetch/browser call counts, errors, and tokens. Tool durations can overlap and must not be summed as task wall time. Manually check whether cited passages support each claim; exact quote matching proves retrieval provenance, not factual entailment.

The [research policy](../../packages/guard/research-policy/README.md) defines budget scope. The [HTTP fetch provider](../../packages/web/web-fetch-http/README.md) defines network access and resource limits.
