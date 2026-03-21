# Documentation project instructions

## About this project

- This is the public documentation site for **AI Site Editor**, built on [Mintlify](https://mintlify.com)
- Pages are MDX files with YAML frontmatter
- Configuration lives in `docs.json`
- Run `mint dev` to preview locally
- Run `mint broken-links` to check links

## Terminology

- **Site owner / adopter**: external developer integrating AI Site Editor with their website
- **Editor**: the Vite+React chat UI app (`apps/editor`)
- **Orchestrator**: the Fastify backend that handles AI planning, operations, and state (`apps/orchestrator`)
- **Block**: a typed content component (Hero, FeatureGrid, etc.) with validated props
- **Operation / op**: a structured, schema-validated edit action (not a freeform code change)
- **Manifest**: the block manifest JSON from `/api/editor/blocks` that tells the editor what blocks are available
- **Draft mode**: Next.js cookie-based preview mode used to switch between published and draft content
- **SPI**: Service Provider Interface — the advanced REST API contract for non-Next.js integrations

## Style preferences

- Use active voice and second person ("you")
- Keep sentences concise — one idea per sentence
- Use sentence case for headings
- Bold for UI elements: Click **Settings**
- Code formatting for file names, commands, paths, and code references
- When referencing env vars, always use `code formatting`
- Distinguish between "site" (the user's website) and "editor" (the AI editing UI)

## Content boundaries

- Document integration contracts, APIs, and operational procedures
- Do not document internal implementation details of the orchestrator planning pipeline
- Do not document unreleased features or internal planning docs
- Keep env var examples generic — do not include real API keys or internal URLs
