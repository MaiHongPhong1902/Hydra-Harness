# @bosch/bh-skill-badge

Optional bundled skill provider that contributes `bh-badge` to `ctx.skills`. The skill supplies the official “powered by bh” Markdown snippets and the packaged PNG for systems that cannot import a remote image reliably.

Mount the plugin to enable the provider. It has no configuration. The shipped CLI composition includes the plugin as `disabled: true`; users must explicitly enable its `skill-badge` row before model or user discovery can find the skill.

The provider exposes its packaged `assets/` directory as the skill resource base. `bh-badge.png` is the 726×120 source asset, and consumers render it at 121×20.

## Model Experience

Indirectly, through `@bosch/bh-tool-skill`, which renders a bounded matching summary on search and the selected skill body on exact load.

#### KV Cache effect

Disabled by default, the plugin changes no request. When enabled, only an explicit search or load appends its metadata or body to request history.

## Known Limitations and Deferred Work

- The provider contributes one fixed skill and has no runtime customization.
- Remote Markdown uses Shields.io; use the packaged PNG when the target cannot fetch remote images reliably.
