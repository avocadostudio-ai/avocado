import type { EditorComponentDefinition } from "./editor-components-contract"

/**
 * Adopter-owned component registry.
 * Keep this file as the source of truth for what editor can edit structurally.
 */
export const siteComponentRegistry: EditorComponentDefinition[] = [
  {
    type: "Hero",
    displayName: "Hero",
    editablePaths: ["heading", "subheading", "ctaText", "ctaHref", "imageUrl", "imageAlt"],
    propsSchema: {
      type: "object",
      properties: {
        heading: { type: "string" },
        subheading: { type: "string" },
        ctaText: { type: "string" },
        ctaHref: { type: "string" },
        imageUrl: { type: "string" },
        imageAlt: { type: "string" }
      },
      required: ["heading", "subheading", "ctaText", "ctaHref", "imageUrl", "imageAlt"]
    },
    defaultProps: {
      heading: "New hero heading",
      subheading: "New hero subheading",
      ctaText: "Get started",
      ctaHref: "/",
      imageUrl: "/hero-generated.svg",
      imageAlt: "Hero image"
    }
  }
]
