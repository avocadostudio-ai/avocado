# Site Provider SPI — Framework-Agnostic Integration Contract

This is the **advanced** integration path for teams not on Next.js, or for enterprise CMS/platform integrations. If you are on Next.js, start with the [default embedded onboarding](nextjs-mvp-embedded.md) instead — it is faster and requires less backend work.

Related docs:
- [Integration overview](README.md) — default fast onboarding path (Next.js embedded mode).
- [Reduce Next.js coupling](../planning/reduce-nextjs-coupling.md) — rationale for default vs advanced integration tiers.

## Context

External developers who want the AI editor to manage their site implement a standard REST API. The orchestrator is the brain (AI planning, operation execution, undo/redo); the provider is your storage backend (pages, media, deployment). This spec defines the contract you implement on your side.

Designed around OpenAPI conventions: separate page properties from content, HEAD for freshness checks, content definition endpoint for discovering block types.

**Design principle**: Push full `PageDoc` objects, not operations. Adopters store/retrieve JSON — no ops engine on their side. Undo/redo and session isolation stay in the orchestrator.

## Endpoints

### Site

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/site` | Site metadata: name, purpose, capabilities, hosting info |

### Pages

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/pages` | List all pages (slug, title, meta). Paginated via `?cursor=` |
| `POST` | `/pages` | Create a new page. Body: `PageDoc` |
| `GET` | `/pages/{id}/properties` | Page metadata (slug, title, meta) — lightweight |
| `PUT` | `/pages/{id}/properties` | Update page metadata |
| `DELETE` | `/pages/{id}` | Delete a page |
| `HEAD` | `/pages/{id}/content` | Content freshness check (ETag/Last-Modified) |
| `GET` | `/pages/{id}/content` | Full block tree: `{ blocks: BlockInstance[] }` |
| `PUT` | `/pages/{id}/content` | Replace full block tree |
| `PATCH` | `/pages/{id}/content` | Partial block update (JSON Patch) |

### Content Definition

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/content-definition` | Components manifest — block types + prop schemas |

### Media

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/media` | Upload image (multipart), returns `{ url }` |

### Deploy

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/deploy` | Trigger publish/deployment. Returns `{ status, deploymentId? }` |

## Auth

`Authorization: Bearer <token>` on every request. Provider gives the orchestrator an API key.

## Schemas

- **PageDoc**: `{ id, slug, title, updatedAt, blocks: BlockInstance[], meta?: PageMeta }`
- **BlockInstance**: `{ id, type: string, props: object }` — `type` unconstrained (adopters bring their own block types)
- **PageMeta**: `{ title?, description?, ogImage? }`
- **SiteInfo**: `{ name, purpose?, capabilities?: SiteCapabilities, hosting? }`
- **ContentDefinition**: `{ blockTypes: [{ type, schema: JSONSchema }] }` — maps to existing `componentsManifest`

## Why Properties/Content Split

The orchestrator often just needs the page list + metadata for AI planning ("which page should I edit?"), not every block's props. Splitting lets adopters serve metadata cheaply and the orchestrator skip loading full content until needed.

## End-to-End Flow

```
User sends chat message: "add a testimonials section to /pricing"
  → Orchestrator calls GET /pages to list adopter's pages
  → Orchestrator calls GET /pages/{id}/content for /pricing
  → AI plans edits, ops engine applies them in-memory
  → Orchestrator calls PUT /pages/{id}/content with updated blocks
  → Orchestrator calls POST /deploy to trigger adopter's deployment
  → User sees updated site
```

## Adopter Implementation Checklist

**Minimum viable (3 endpoints):**
1. `GET /pages` — return all pages with slugs and titles
2. `GET /pages/{id}/content` — return block tree for a page
3. `PUT /pages/{id}/content` — accept updated block tree

**Recommended additions:**
4. `POST /media` — accept image uploads, return public URLs
5. `POST /deploy` — trigger a build/deploy
6. `GET /content-definition` — expose custom block types and schemas
7. `GET /site` — provide site metadata and capabilities

**Nice to have:**
8. `HEAD /pages/{id}/content` — ETag support for cache optimization
9. `PATCH /pages/{id}/content` — partial updates via JSON Patch
10. `GET/PUT /pages/{id}/properties` — separate metadata access

## Configuration

The orchestrator connects to a provider via environment variables:

| Variable | Required | Description |
|---|---|---|
| `SITE_PROVIDER_URL` | Yes | Provider API base URL (e.g. `https://your-cms.example.com/api/site-editor`) |
| `SITE_PROVIDER_TOKEN` | Yes | API key for `Authorization: Bearer` header on all provider requests |

When `SITE_PROVIDER_URL` is not set, the orchestrator falls back to its built-in local storage (in-memory drafts + disk persistence).
