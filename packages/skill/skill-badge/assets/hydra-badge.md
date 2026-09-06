# Hydra harness Badge

Add the “powered by Hydra harness” badge using the supplied artwork.

## Asset

Use [`hydra-badge.png`](hydra-badge.png) from this skill directory. The source image is 1080×168; render at 180×28 and preserve its aspect ratio.

## Markdown

Copy the PNG beside the target document, then use:

```markdown
![Powered by Hydra harness](hydra-badge.png)
```

Adjust the relative path to the copied file. For a pull request, merge request, or system that accepts image uploads, upload the bundled PNG and use the returned image URL. Do not reference a local filesystem path in remote content.

## Usage rules

- Preserve the badge's 180×28 display dimensions and aspect ratio where the target supports sizing.
- Place the badge at the end of the attributed document or section unless the user specifies another position.
- Use the supplied colors, Hydra logo, and label. Link to a project only when its URL is provided or verified.
