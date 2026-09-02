# Agent Note: OpenAI/Codex marketplace ownership

Status: implemented

## Problem

The native BH marketplace modeled npm packages and invoked `bh plugin`, while imported plugins used OpenAI/Codex bundles. Maintaining both marketplace models made a source ambiguous and forced plugin authors to support an unused BH package format.

## Decision

`pluginInventory` accepts OpenAI/Codex marketplace sources only. It validates `.agents/plugins/marketplace.json` or root `marketplace.json`, persists the source, and removes it without changing any imported bundle. It no longer projects package metadata or invokes `bh plugin` to install a catalog package.

The imported-plugin runtime remains the only marketplace-entry importer. It stages the selected OpenAI/Codex bundle, validates `.codex-plugin/plugin.json`, and keeps source-qualified lifecycle, MCP approval, and hook trust. The Settings ownership split is recorded in [Plugin source and capability separation](../feature/2026-09-02-plugin-source-and-capability-separation.md).

## Alternatives considered

**Keep the BH marketplace beside the OpenAI/Codex importer.** Rejected because the two catalogs install incompatible formats and create a second plugin-management path without a current owner.

**Translate OpenAI/Codex catalog entries into BH packages.** Rejected because a bundle imports directly and translation would recreate the unsupported BH package contract.

## Consequences

Marketplace sources must use the OpenAI/Codex bundle catalog format. Existing BH runtime bundles remain part of the application composition, but Settings no longer installs BH package plugins. Focused Host and client tests verify source validation, source removal, direct bundle import, and the separated capability tabs.
