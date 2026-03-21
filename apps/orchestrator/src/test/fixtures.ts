import type { PageDoc, BlockManifest } from "@ai-site-editor/shared"
import {
  draftPages,
  historyUndo,
  historyRedo,
  versions,
  recentEdits
} from "../state/session-state.js"
import { app } from "../index.js"

// ---------------------------------------------------------------------------
// Page factories
// ---------------------------------------------------------------------------

export function makeHomePage(overrides: Partial<PageDoc> = {}): PageDoc {
  return {
    id: "p_home",
    slug: "/",
    title: "Home",
    updatedAt: "2026-01-01T00:00:00.000Z",
    blocks: [
      {
        id: "b_hero",
        type: "Hero",
        props: {
          heading: "Hello",
          subheading: "World",
          ctaText: "Click",
          ctaHref: "/pricing",
          imageUrl: "/hero.svg",
          imageAlt: "Hero"
        }
      },
      {
        id: "b_cta",
        type: "CTA",
        props: {
          title: "Ready?",
          description: "Go for it.",
          ctaText: "Go",
          ctaHref: "/"
        }
      }
    ],
    ...overrides
  }
}

export function makePricingPage(): PageDoc {
  return {
    id: "p_pricing",
    slug: "/pricing",
    title: "Pricing",
    updatedAt: "2026-01-01T00:00:00.000Z",
    blocks: [
      {
        id: "b_hero_pricing",
        type: "Hero",
        props: {
          heading: "Pricing",
          subheading: "Plans",
          ctaText: "Buy",
          ctaHref: "/",
          imageUrl: "/hero.svg",
          imageAlt: "Pricing hero"
        }
      }
    ]
  }
}

export function makeFeaturePage(): PageDoc {
  return {
    id: "p_features",
    slug: "/features",
    title: "Features",
    updatedAt: "2026-01-01T00:00:00.000Z",
    blocks: [
      {
        id: "b_grid",
        type: "FeatureGrid",
        props: {
          title: "Our Features",
          features: [
            { title: "Fast", description: "Speedy." },
            { title: "Safe", description: "Secure." },
            { title: "Simple", description: "Easy." }
          ]
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Manifest fixtures
// ---------------------------------------------------------------------------

export const CTA_ONLY_MANIFEST: BlockManifest = {
  version: 1,
  blocks: [
    {
      type: "CTA",
      propsSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          ctaText: { type: "string" },
          ctaHref: { type: "string" }
        },
        required: ["title", "description", "ctaText", "ctaHref"]
      }
    }
  ]
}

// ---------------------------------------------------------------------------
// Session helpers (direct state manipulation — for unit tests)
// ---------------------------------------------------------------------------

export function seedSession(sessionId: string, ...pages: PageDoc[]) {
  const sessionMap = new Map<string, PageDoc>()
  for (const page of pages) sessionMap.set(page.slug, structuredClone(page))
  draftPages.set(sessionId, sessionMap)
}

export function getDraft(sessionId: string, slug: string) {
  return draftPages.get(sessionId)?.get(slug) ?? null
}

export function resetSessionState(sessionId: string) {
  draftPages.delete(sessionId)
  historyUndo.delete(sessionId)
  historyRedo.delete(sessionId)
  versions.delete(sessionId)
  recentEdits.delete(sessionId)
}

// ---------------------------------------------------------------------------
// Session counter (unique session IDs per test file)
// ---------------------------------------------------------------------------

let globalCounter = 0

export function createSessionFactory(prefix: string) {
  return () => `${prefix}-${++globalCounter}`
}

// ---------------------------------------------------------------------------
// SSE helpers (for HTTP contract/integration tests)
// ---------------------------------------------------------------------------

export function parseSseData(body: string) {
  const events: Array<Record<string, unknown>> = []
  const chunks = body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)

  for (const chunk of chunks) {
    const line = chunk
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("data:"))
    if (!line) continue
    const raw = line.slice("data:".length).trim()
    if (!raw) continue
    try {
      events.push(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      // ignore malformed non-JSON lines
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// HTTP helpers (for integration tests via Fastify .inject())
// ---------------------------------------------------------------------------

type OpsPayload = { session: string; ops: unknown[] }

export async function postOps(payload: OpsPayload) {
  return app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  })
}

export async function getPage(session: string, slug: string) {
  return app.inject({
    method: "GET",
    url: `/draft/pages?session=${encodeURIComponent(session)}&slug=${encodeURIComponent(slug)}`
  })
}

export async function getSlugs(session: string) {
  const res = await app.inject({
    method: "GET",
    url: `/draft/slugs?session=${encodeURIComponent(session)}`
  })
  return JSON.parse(res.body) as { slugs: string[] }
}
