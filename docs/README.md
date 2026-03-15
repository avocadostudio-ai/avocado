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
| [Custom Tools](integration/tools-mvp.md) | Register PIM, DAM, or other tools with the AI planner |

## Architecture

| Doc | Description |
|-----|-------------|
| [Current State](architecture/current-state.md) | System overview and component relationships |
| [Product Design Summary](architecture/product-design-architecture-summary.md) | High-level product architecture |
| [C4 Diagrams](c4/README.md) | Mermaid-based architecture diagrams |
| [Editor Refactoring](architecture/editor-app-refactoring.md) | Editor app restructuring plan |
| [Section Terminology](architecture/section-terminology-and-naming-conventions.md) | Naming conventions across the codebase |

## Operations

| Doc | Description |
|-----|-------------|
| [Vercel Deployment](operations/vercel-deployment.md) | Deploy site and editor to Vercel |
| [Dev Server Runbook](operations/dev-server-runbook.md) | Local dev server setup and troubleshooting |
| [Streaming Transport](operations/streaming-optimistic-patch-transport-checklist.md) | Optimistic patch streaming checklist |

## Observability

| Doc | Description |
|-----|-------------|
| [Chat Troubleshooting](observability/chat-behavior-troubleshooting.md) | Debug chat and AI planning issues |
| [Telemetry Events](observability/chat-telemetry-events.md) | Chat event tracking reference |
| [Token Usage](observability/token-usage-tracking.md) | AI token consumption tracking |
| [Tracing Plan](observability/observability-as-correctness-tracing-plan.md) | Observability-as-correctness approach |

## Guardrails

| Doc | Description |
|-----|-------------|
| [Schema Concept](guardrails/guardrail-schema-concept.md) | Guardrail schema design |
| [V1 Spec](guardrails/guardrail-schema-v1-spec.md) | Guardrail schema v1 specification |
| [Implementation Checklist](guardrails/guardrail-schema-v1-implementation-checklist.md) | V1 implementation tracking |

## Planning

| Doc | Description |
|-----|-------------|
| [Reduce Next.js Coupling](planning/reduce-nextjs-coupling-plan.md) | Two-tier integration model rationale |
| [Anthropic Optimization](planning/anthropic-optimization-implementation-plan.md) | Anthropic API optimization plan |
| [Editor-First AI Bridge](planning/editor-first-ai-bridge-plan.md) | Editor ↔ AI bridge architecture |
| [Missing Ops](planning/missing-ops-plan.md) | Planned block operations |
| [Improvements](planning/things-to-improve.md) | Backlog of improvements |

## Testing

| Doc | Description |
|-----|-------------|
| [Demo Runbook](testing/avocado-transformation-demo-runbook.md) | Avocado Stories demo walkthrough |
| [E2E Editing Prompts](testing/e2e-editing-prompts.md) | Test prompts for manual QA |

## Specs

| Doc | Description |
|-----|-------------|
| [POC Spec](specs/ai-website-editor-poc-spec.md) | Original proof-of-concept specification |
