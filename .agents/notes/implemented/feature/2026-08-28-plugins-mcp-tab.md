# Agent Note: Plugins MCP tab

Status: implemented

## Problem

Obsidian knowledge used a local MCP server, but its user-owned target hostname and credential had no focused in-app setup page. The generic plugin inventory could toggle the owning plugin, while the generic configuration tab did not explain which values made MCP usable.

## Decision

The Plugins Settings section includes an **MCP** tab between **Plugin configuration** and **Plugin list**. Its Obsidian MCP card binds the existing `obsidian-knowledge` settings namespace and stages the optional `targetDomain` alongside the write-only `OBSIDIAN_API_KEY` credential. Settings writes retain revision fencing, credential literals never ride a browser response, and each store independently controls whether its field is writable.

The tab reports an unavailable plugin instead of rendering inert controls. It displays the fixed loopback destination but does not make the endpoint a user setting; deployment configuration and the Obsidian plugin's loopback validation remain authoritative.

## Alternatives considered

**Add MCP fields to Plugin configuration.** Rejected because a dedicated tab makes the server setup discoverable without mixing it into unrelated shell, loop, and search settings.

**Build a generic MCP registry and server editor.** Rejected because Hydra currently owns one bounded MCP consumer, and no runtime metadata supports safe generic discovery or arbitrary endpoint editing.

**Store the bearer token in the settings document.** Rejected because settings sections are readable by the browser; the credentials domain already provides a write-only control and configured-state projection.

## Consequences

Users can complete the existing Obsidian MCP setup from Plugins without exposing the stored key or weakening the loopback endpoint restriction. Plugin enablement remains in **Plugin list**, so the MCP tab adds no second activation mechanism. A generic server catalog, custom endpoint editor, transport selection, and raw MCP tool controls remain absent until another concrete MCP consumer requires them.

The apply test pins tab order and credential invalidation, while focused controller and component tests pin settings and credential writes, unavailable state, secret rendering, and independent writability.
