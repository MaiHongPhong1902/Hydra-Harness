# Agent Note: Present executable documentation commands as copyable blocks

Status: implemented

## Problem

Documentation readers could not reliably distinguish a command to run from source code or terminal output, and command fences inherited a small icon-only copy control whose copied text could include shell prompts.

## Decision

The VitePress fence renderer classifies shell-language fences as command blocks and explicit `output` fences as terminal output. Command content is normalized to remove leading `$`, `>`, and PowerShell prompts before highlighting, while VitePress's existing Clipboard API handler copies the resulting block and supplies its temporary copied state. Output blocks keep their text-only presentation and have no copy control.

The site stylesheet gives command and output blocks distinct borders, backgrounds, labels, spacing, and rounded containers. Command fences use a visible text button with `Copy` and `Copied` states; source-code fences retain the stock VitePress presentation. Documentation marks captured stdout/stderr with `output` and promotes direct executable examples to shell fences.

## Alternatives considered

**A new copy-button component** — rejected. VitePress already owns Clipboard API fallback, prompt stripping, and copied-state timing, so decorating its generated fence is smaller and keeps behavior consistent with the theme.

**Inferring terminal output from untagged fences** — rejected. Output is intentionally explicit so logs and executable commands cannot be misclassified by content heuristics.

## Consequences

Readers can identify runnable commands immediately and copy the raw command without a prompt. Authors must use shell-language fences for executable commands and `output` for captured terminal output; source snippets keep their language tags and default handling.

## Verification

The renderer helper has focused tests for fence classification, prompt removal, command decoration, and output copy removal. The documentation build and a real browser interaction verify the generated command block and Clipboard API state.
