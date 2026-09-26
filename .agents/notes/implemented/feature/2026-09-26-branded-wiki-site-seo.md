# Agent Note: Branded wiki documentation site

Status: implemented

## Problem

The published documentation page exposed the content but gave visitors no visual entry point, product identity, or search metadata beyond the generic VitePress defaults.

## Decision

The documentation home page keeps its canonical Markdown source in `docs/user/index.md` and now starts with a Hydra-branded hero, a six-card wiki index, and the existing complete feature guide. The presentation layer in `website/.vitepress/config.ts` owns the pixel-art navy and azure visual treatment, responsive layout, reduced-motion behavior, PNG favicon, per-route canonical and social metadata, and home-page SoftwareApplication JSON-LD. `website/public/robots.txt` points crawlers to the generated sitemap.

## Alternatives considered

**A separate website Markdown tree was rejected** because `website/AGENTS.md` requires canonical documentation to stay under `docs/` and the projector already supplies the VitePress routes.

**A new UI dependency was rejected** because semantic HTML and the existing VitePress theme provide the required navigation, accessibility, and responsive behavior with less maintenance.

## Consequences

The home page has a distinct Hydra identity and useful crawl metadata while every existing guide, reference, and development page remains in the same publication manifest. The hero links use the public Pages URL so they work from both the generated site and repository-rendered Markdown; changing the Pages hostname requires updating those links and the SEO base together.
