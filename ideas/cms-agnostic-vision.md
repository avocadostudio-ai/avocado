# CMS-Agnostic Vision: From SPI Narrative to Implemented Product Path

## Current State
- The current production integration model is Next.js embedded mode with orchestrator-managed draft state and publish flows.
- The framework-agnostic Site Provider SPI is documented, but orchestrator runtime does not yet execute against provider endpoints as a first-class path.
- Content bootstrap and editing assumptions currently favor app-managed page models over external CMS provider contracts.

## Problem Statement
The product message "works across any CMS" is ahead of implementation reality.  
Today, teams can conceptually map to the SPI, but they cannot rely on a completed provider runtime path that replaces Next.js-specific flows end to end.

This creates three risks:
- expectation risk: product promise outpaces actual onboarding path,
- integration risk: enterprise CMS teams must build custom glue,
- scaling risk: lack of a standard provider runtime increases one-off integration cost.

## Target State
AI Site Editor supports two first-class integration modes:
1. Next.js embedded mode (default, fastest adoption).
2. Provider adapter mode (framework-agnostic CMS/storage integration).

Both modes share:
- the same operation semantics,
- the same safety and validation guardrails,
- the same editor UX contract.

## Target Architecture
### 1) Provider adapter boundary in orchestrator
- Introduce a provider gateway abstraction in orchestrator for page/catalog/content/deploy operations.
- Keep ops engine and planning logic provider-neutral; adapter handles transport and provider semantics.

### 2) Content-definition and manifest ingestion
- Ingest provider `content-definition` as canonical structural capability input.
- Normalize provider definitions into internal `componentsManifest` shape used by planning and validation.

### 3) Page read/write sync contract
- Read path: provider page metadata + content retrieval to seed/refresh orchestrator draft sessions.
- Write path: orchestrator applies validated operations in-memory, then persists resulting page content via provider write APIs.
- Reconciliation: add explicit version/concurrency handling to avoid silent overwrite.

### 4) Publish and deploy integration contract
- Standardize deploy trigger semantics and status polling contract for provider mode.
- Separate "content persisted" from "deployment completed" in API status to preserve operational truth.

## Compatibility Strategy
- Keep Next.js embedded as default onboarding path and quality bar.
- Build provider mode in parallel, not as a replacement, so existing adopters are unaffected.
- Ensure both modes expose equivalent editing capabilities where provider schema allows.
- Use capability flags to prevent unsupported operations rather than failing late.

## Priority Buckets
### P0: Generic provider runtime contract and minimal adapter flow
- Implement provider adapter interface in orchestrator with minimal required endpoints:
  - page list/read,
  - page content write,
  - content definition read.
- Add provider configuration and auth handling with explicit startup validation.
- Deliver one reference adapter path that can complete read-edit-write for a single site.

### P1: Durable sync, conflict handling, and versioning
- Add optimistic concurrency and conflict outcomes for provider writes.
- Add retry and idempotency strategy for transient provider failures.
- Add structured error taxonomy for provider transport vs schema vs conflict failures.

### P2: First-class CMS adapters and governance/observability
- Add supported adapter packages/profiles for target CMS ecosystems.
- Add provider-mode observability dashboards and SLOs (latency, error classes, conflict rate).
- Add governance controls for enterprise flows (audit fields, deployment policy hooks).

## Success Metrics
- Time-to-integrate a new provider mode implementation is reduced to a bounded implementation window with documented required endpoints.
- Percentage of structural edits supported in provider mode matches declared provider capabilities (no hidden unsupported behavior).
- Provider write and deploy reliability meets defined success/error-budget targets.
- Reduction in custom one-off integration code required per CMS adopter.
