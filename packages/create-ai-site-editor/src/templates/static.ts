import type { GeneratedFile, ScaffoldConfig } from "../types.js"

export function staticTemplates(_config: ScaffoldConfig): GeneratedFile[] {
  return [
    { path: "content/pages.json", content: samplePagesJson() },
  ]
}

function samplePagesJson(): string {
  return `[
  {
    "id": "home",
    "slug": "/",
    "title": "Home",
    "blocks": [
      {
        "id": "hero-1",
        "type": "Hero",
        "props": {
          "heading": "Welcome to your site",
          "subheading": "Edit this content using the AI site editor",
          "ctaText": "Get started",
          "ctaHref": "#",
          "imageUrl": "/hero-generated.svg",
          "imageAlt": "Hero image",
          "imagePosition": "right"
        }
      }
    ],
    "updatedAt": "${new Date().toISOString()}"
  }
]
`
}
