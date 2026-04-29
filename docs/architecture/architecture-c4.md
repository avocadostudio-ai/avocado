# System Architecture — C4 Diagrams

## Level 1: System Context

Who uses what, and how the systems connect.

```mermaid
C4Context
    title System Context — Avocado Studio

    Person(visitor, "Site Visitor", "Views the published website")
    Person(editor_user, "Editor User", "Edits site content via chat")

    System(site, "Site", "Next.js on Vercel — serves static pages to visitors, draft pages to editor")
    System(editor, "Editor UI", "React SPA on Vercel — chat interface for editing")
    System(orchestrator, "Orchestrator", "Fastify API on Render — AI planning, session state, publishing")
    System_Ext(llm, "LLM Provider", "OpenAI, Anthropic, or any compatible API")

    Rel(visitor, site, "Visits pages", "HTTPS")
    Rel(editor_user, editor, "Chats, selects blocks", "HTTPS")
    Rel(editor, site, "Embeds as iframe", "postMessage")
    Rel(editor, orchestrator, "Sends chat messages, receives operations", "HTTPS")
    Rel(site, orchestrator, "Fetches draft content (preview) + syncs at build", "HTTPS")
    Rel(orchestrator, llm, "Generates edit plans", "HTTPS")
```

## Level 2: Container Diagram

What runs where, and the two modes of operation.

```mermaid
C4Container
    title Container Diagram — Production Deployment

    Person(visitor, "Site Visitor")
    Person(editor_user, "Editor User")

    System_Boundary(vercel, "Vercel") {
        Container(site, "Site", "Next.js SSG", "Static pages from published-content.json + draft API routes for preview")
        Container(editor_spa, "Editor UI", "Vite + React SPA", "Chat UI, model picker, iframe preview")
    }

    System_Boundary(render, "Render") {
        Container(orchestrator, "Orchestrator", "Fastify", "Session state, AI planning, operations engine, publish API")
    }

    System_Ext(llm, "LLM Provider", "Bring your own: OpenAI, Anthropic, etc.")

    Rel(visitor, site, "GET /", "HTTPS — static HTML")
    Rel(editor_user, editor_spa, "Opens editor", "HTTPS")
    Rel(editor_spa, orchestrator, "POST /chat, GET /sessions/*", "HTTPS")
    Rel(editor_spa, site, "Loads in iframe, activates draft mode", "postMessage + /api/draft")
    Rel(site, orchestrator, "GET /sessions/*/pages/* (draft)", "HTTPS")
    Rel(orchestrator, llm, "Chat completions", "HTTPS")
    Rel(orchestrator, site, "Syncs content at build time via /publish/content", "HTTPS (build only)")
```

## Flow 1: Production — Static Site Visitor

No orchestrator involved at runtime. Pure static HTML.

```mermaid
sequenceDiagram
    participant V as Site Visitor
    participant CDN as Vercel CDN
    participant Build as Vercel Build

    Note over Build: Build time (on deploy)
    Build->>+Orchestrator: GET /publish/content?session=dev&siteId=avocado-stories
    Orchestrator-->>-Build: { pages: [...] }
    Build->>Build: Write published-content.json
    Build->>Build: next build → generateStaticParams() → SSG

    Note over V,CDN: Runtime (visitor request)
    V->>+CDN: GET /pricing
    CDN-->>-V: Static HTML + JS (pre-rendered)
    Note over V: No editor overlay<br/>No draft mode<br/>No orchestrator calls
```

## Flow 2: Editor — Draft Preview (Live Editing)

Editor user sees real-time changes in the iframe preview.

```mermaid
sequenceDiagram
    participant U as Editor User
    participant E as Editor UI<br/>(Vite SPA)
    participant O as Orchestrator<br/>(Render)
    participant AI as LLM Provider
    participant S as Site<br/>(Next.js)

    U->>E: Opens editor, starts session

    Note over E,S: 1. Activate draft preview
    E->>S: GET /api/draft?secret=***&redirect=/
    S->>S: Enable Next.js draft mode cookie
    S-->>E: 302 redirect (iframe reloads in draft mode)

    Note over U,AI: 2. User edits via chat
    U->>E: "Change the hero headline to 'Adventure Awaits'"
    E->>O: POST /chat { message, session, siteId }
    O->>AI: Generate edit plan
    AI-->>O: EditPlan { operations: [...] }
    O->>O: Apply operations to in-memory session state
    O-->>E: SSE stream: operations + updated page

    Note over E,S: 3. Preview updates
    E->>S: postMessage("site-editor/v1", { type: "refresh" })
    S->>O: GET /sessions/dev/pages/?slug=/&siteId=...
    O-->>S: Updated PageDoc (draft)
    S-->>E: Re-rendered page in iframe
    U->>U: Sees updated headline instantly

    Note over U,O: 4. Publish
    U->>E: Clicks "Publish"
    E->>O: POST /publish { session, siteId }
    O->>O: Commit published-content.json to git
    O-->>E: { ok: true }
    Note over S: Vercel auto-deploys from git push<br/>→ new static build with updated content
```

## Flow 3: What Each Env Var Controls

```
┌─────────────────────────────────┬──────────────────────────────────────────────┐
│ Env Var                         │ Effect in Production                         │
├─────────────────────────────────┼──────────────────────────────────────────────┤
│ ORCHESTRATOR_URL (set)          │ Build: sync script fetches latest content    │
│                                 │ Runtime: draft mode can reach orchestrator   │
├─────────────────────────────────┼──────────────────────────────────────────────┤
│ DRAFT_MODE_SECRET (set)         │ /api/draft route works → editor can          │
│                                 │ activate draft preview in iframe             │
├─────────────────────────────────┼──────────────────────────────────────────────┤
│ NEXT_PUBLIC_ENABLE_EDITOR (off) │ EDITOR_ENABLED = false → no preview bridge, │
│                                 │ no editor overlay, no selectable blocks      │
├─────────────────────────────────┼──────────────────────────────────────────────┤
│ NEXT_PUBLIC_EDITOR_ORIGIN (off) │ Not needed — editor communicates via         │
│                                 │ postMessage with origin passed in URL params │
└─────────────────────────────────┴──────────────────────────────────────────────┘
```
