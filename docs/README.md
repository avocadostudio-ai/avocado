# Documentation

## For Site Owners & Adopters

Start here if you want to add AI-powered editing to your website.

| Doc | Description |
|-----|-------------|
| [Integration Overview](integration/README.md) | Entry point — tiers, checklist, SDK overview |
| [Next.js Onboarding](integration/nextjs-mvp-embedded.md) | 30-minute setup with `@ai-site-editor/site-sdk` |
| [Adoption Example](integration/nextjs-mvp-adoption-example.md) | Full code example for `app/[[...slug]]/page.tsx` |
| [Editor Quickstart](integration/editor-quickstart.md) | Draft mode URLs, behavior checks, self-check commands |
| [Framework-Agnostic SPI](integration/site-provider-spi.md) | REST API contract for non-Next.js integrations |
| [Custom Tools](integration/tools-mvp.md) | Configure PIM, DAM, or other tools for the AI planner |
| [Adoption guide for AI agents](integration/ai-coding-agents-adoption.md) | Paste into your agent to integrate AI Site Editor into your site |
| [Contributing guide for AI agents](integration/ai-coding-agents.md) | For agents working on the AI Site Editor codebase itself |

## Architecture

| Doc | Description |
|-----|-------------|
| [Current State](architecture/current-state.md) | System overview and component relationships |
| [Product Design](architecture/product-design.md) | High-level product architecture |
| [C4 Diagrams (Mermaid)](c4/README.md) | Mermaid-based architecture diagrams |
| [C4 Diagrams (Markdown)](architecture/architecture-c4.md) | System architecture C4 diagrams |
| [Editor Refactor](architecture/editor-app-refactor.md) | Editor app restructuring plan |
| [Naming Conventions](architecture/naming-conventions.md) | Naming conventions across the codebase |
| [Selector Anchored Prompt](architecture/selector-anchored-prompt.md) | Selector toggle + hybrid anchored prompt |
| [OpenAI Pipeline Review](architecture/openai-pipeline-fix-review.md) | Architecture review of OpenAI pipeline fix |
| [Site Agent Modes](architecture/site-agent-modes.md) | Create/migrate/integrate modes, triage, intent-adaptive prompts |

## Operations

| Doc | Description |
|-----|-------------|
| [Vercel Deployment](operations/vercel-deployment.md) | Deploy site and editor to Vercel |
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

## Guardrails

| Doc | Description |
|-----|-------------|
| [Schema Concept](guardrails/guardrail-schema-concept.md) | Guardrail schema design |
| [V1 Spec](guardrails/guardrail-schema-v1-spec.md) | Guardrail schema v1 specification |
| [Implementation Checklist](guardrails/guardrail-schema-v1-implementation-checklist.md) | V1 implementation tracking |

## Planning

| Doc | Description |
|-----|-------------|
| [Reduce Next.js Coupling](planning/reduce-nextjs-coupling.md) | Two-tier integration model rationale |
| [Anthropic Optimization](planning/anthropic-optimization.md) | Anthropic API optimization |
| [Editor-First AI Bridge](planning/editor-first-ai-bridge.md) | Editor ↔ AI bridge architecture |
| [Missing Ops](planning/missing-ops.md) | Planned block operations |
| [Google Drive Image Source](planning/google-drive-image-source.md) | Google Drive as image source |
| [New Blocks Plan](planning/new-blocks-plan.md) | 10 new blocks from AEM EDS gap analysis |
| [shadcn/ui Migration](planning/shadcn-migration.md) | Editor UI migration to shadcn/ui |
| [Backlog](planning/backlog.md) | Prioritized improvement backlog |
| [Post-MVP Improvements](planning/post-mvp-improvements.md) | Post-core-editor-UX improvements |

## Ideas

| Doc | Description |
|-----|-------------|
| [Chunked Execution](ideas/chunked-execution.md) | Chunked plan execution with continue feature |
| [CMS-Agnostic Vision](ideas/cms-agnostic-vision.md) | SPI narrative to product implementation |
| [Fix-Ops Improvements](ideas/fix-ops-improvements.md) | Prioritized fix-ops improvements |
| [Next.js-First Promise](ideas/nextjs-first-promise.md) | Next.js-first delivery promise and roadmap |
| [Property Editor Improvements](ideas/property-editor-improvements.md) | Property editor UX improvements |
| [Live DOM Vision](ideas/live-dom-vision.md) | Live DOM runtime understanding vision |

## Testing

| Doc | Description |
|-----|-------------|
| [Demo Runbook](testing/avocado-transformation-demo-runbook.md) | Avocado Stories demo walkthrough |
| [E2E Editing Prompts](testing/e2e-editing-prompts.md) | Test prompts for manual QA |

## Specs

| Doc | Description |
|-----|-------------|
| [POC Spec](specs/ai-website-editor-poc-spec.md) | Original proof-of-concept specification |
