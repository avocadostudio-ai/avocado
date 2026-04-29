# Documentation

## For Site Owners & Adopters

Start here if you want to add AI-powered editing to your website.

| Doc | Description |
|-----|-------------|
| [Integration Overview](integration/README.md) | Entry point — tiers, checklist, SDK overview |
| [Next.js Onboarding](integration/nextjs-mvp-embedded.md) | 30-minute setup with `@ai-site-editor/site-sdk` |
| [Adoption Example](integration/nextjs-mvp-adoption-example.md) | Full code example for `app/[[...slug]]/page.tsx` |
| [Content Studio Quickstart](integration/editor-quickstart.md) | Draft mode URLs, behavior checks, self-check commands |
| [Framework-Agnostic SPI](integration/site-provider-spi.md) | REST API contract for non-Next.js integrations |
| [Custom Tools](integration/tools-mvp.md) | Configure PIM, DAM, or other tools for the AI planner |
| [Adoption guide for AI agents](integration/ai-coding-agents-adoption.md) | Paste into your agent to integrate Avocado Studio into your site |
| [Contributing guide for AI agents](integration/ai-coding-agents.md) | For agents working on the Avocado Studio codebase itself |

## Architecture

| Doc | Description |
|-----|-------------|
| [Current State](architecture/current-state.md) | System overview and component relationships |
| [Product Design](architecture/product-design.md) | High-level product architecture |
| [C4 Diagrams (Mermaid)](c4/README.md) | Mermaid-based architecture diagrams |
| [C4 Diagrams (Markdown)](architecture/architecture-c4.md) | System architecture C4 diagrams |
| [Naming Conventions](architecture/naming-conventions.md) | Naming conventions across the codebase |
| [Site Agent Modes](architecture/site-agent-modes.md) | Create/migrate/integrate modes, triage, intent-adaptive prompts |

## Operations

| Doc | Description |
|-----|-------------|
| [Docker Deployment](operations/docker-deployment.md) | Deploy the orchestrator as a Docker image |
| [Vercel Deployment](operations/vercel-deployment.md) | Deploy site and Content Studio to Vercel |
| [Netlify Deployment](operations/netlify-deployment.md) | Deploy site and Content Studio to Netlify |
| [Dev Server Runbook](operations/dev-server-runbook.md) | Local dev server setup and troubleshooting |
| [Streaming Patch Checklist](operations/streaming-patch-checklist.md) | Optimistic patch streaming checklist |

## Observability

| Doc | Description |
|-----|-------------|
| [Chat Troubleshooting](observability/chat-troubleshooting.md) | Debug chat and AI planning issues |
| [Telemetry Events](observability/chat-telemetry-events.md) | Chat event tracking reference |
| [Token Usage](observability/token-usage-tracking.md) | AI token consumption tracking |
| [E2E Tracing](observability/e2e-tracing.md) | End-to-end correlation tracing |
| [BigQuery Analytics](observability/bigquery-analytics.md) | BigQuery analytics integration |

## Testing

| Doc | Description |
|-----|-------------|
| [Demo Runbook](testing/avocado-transformation-demo-runbook.md) | Avocado Stories demo walkthrough |
| [E2E Editing Prompts](testing/e2e-editing-prompts.md) | Test prompts for manual QA |

---

Additional internal planning and design documents are available in the `planning/`, `ideas/`, `specs/`, and `guardrails/` directories.
