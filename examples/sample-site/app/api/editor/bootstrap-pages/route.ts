import { createBootstrapPagesHandler } from "@ai-site-editor/site-sdk/routes"
import type { PageDoc } from "@ai-site-editor/shared"

const seedPages: PageDoc[] = [
  {
    id: "home",
    slug: "/",
    title: "Home",
    updatedAt: new Date().toISOString(),
    blocks: [
      {
        id: "hero-1",
        type: "Hero",
        props: {
          heading: "Welcome to Sample Site",
          subheading: "This site proves the SDK works for third-party integrations.",
          ctaText: "Get Started",
          ctaHref: "#",
          layout: "centered",
          imageUrl: "",
        },
      },
    ],
  },
]

export const { GET, OPTIONS } = createBootstrapPagesHandler(() => seedPages)
