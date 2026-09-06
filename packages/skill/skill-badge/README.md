# @hydra/harness-skill-badge

Optional bundled skill provider that contributes `hydra-badge` to `ctx.skills`. The skill supplies the official “powered by Hydra harness” Markdown snippets and the packaged Hydra PNG for documents and image uploads.

Mount the plugin to enable the provider. It has no configuration. The shipped CLI composition includes the plugin as `disabled: true`; users must explicitly enable its `skill-badge` row before model or user discovery can find the skill.

The provider exposes its packaged `assets/` directory as the skill resource base. `hydra-badge.png` is the 1080×168 source asset, and consumers render it at 180×28.

## Model Experience

Indirectly, through `@hydra/harness-tool-skill`, which renders a bounded matching summary on search and the selected skill body on exact load.

#### KV Cache effect

Disabled by default, the plugin changes no request. When enabled, only an explicit search or load appends its metadata or body to request history.

## Known Limitations and Deferred Work

- The provider contributes one fixed skill and has no runtime customization.
- Remote content requires uploading the packaged PNG or copying it into the target repository.
