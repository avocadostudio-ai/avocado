import { NextResponse } from "next/server"

/**
 * MVP manifest endpoint.
 * Replace with your real component registry and schemas.
 */
export async function GET() {
  return NextResponse.json({
    version: 1,
    components: [
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
  })
}

