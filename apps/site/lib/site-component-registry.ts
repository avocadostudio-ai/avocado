import type { EditorComponentDefinition } from "./editor-components-contract"

const COMPONENTS: EditorComponentDefinition[] = [
  {
    type: "Hero",
    displayName: "Hero",
    propsSchema: {
      type: "object",
      properties: {
        heading: { type: "string" },
        subheading: { type: "string" },
        ctaText: { type: "string" },
        ctaHref: { type: "string" },
        imageUrl: { type: "string" },
        imageAlt: { type: "string" },
        secondaryCtaText: { type: "string" },
        secondaryCtaHref: { type: "string" }
      }
    },
    defaultProps: {
      heading: "Build with confidence",
      subheading: "Make changes safely with instant preview.",
      ctaText: "Get Started",
      ctaHref: "/",
      imageUrl: "/hero-generated.svg",
      imageAlt: "Abstract generated illustration"
    }
  },
  {
    type: "FeatureGrid",
    displayName: "Feature Grid",
    propsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        features: {
          type: "array",
          items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } } }
        }
      }
    },
    defaultProps: {
      title: "Key features",
      features: [
        { title: "Fast setup", description: "Launch quickly with guided defaults." },
        { title: "Safe edits", description: "Structured operations keep content valid." },
        { title: "Live updates", description: "Preview changes immediately." }
      ]
    }
  },
  {
    type: "Testimonials",
    displayName: "Testimonials",
    propsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        items: {
          type: "array",
          items: { type: "object", properties: { quote: { type: "string" }, author: { type: "string" } } }
        }
      }
    },
    defaultProps: {
      title: "What customers say",
      items: [
        { quote: "We launched faster than expected.", author: "Alex" },
        { quote: "Editing is straightforward for the whole team.", author: "Jordan" }
      ]
    }
  },
  {
    type: "FAQAccordion",
    displayName: "FAQ Accordion",
    propsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        items: {
          type: "array",
          items: { type: "object", properties: { q: { type: "string" }, a: { type: "string" } } }
        }
      }
    },
    defaultProps: {
      title: "Frequently asked questions",
      items: [
        { q: "How fast can we publish?", a: "Most teams ship updates in minutes." },
        { q: "Can we revise later?", a: "Yes, every block can be updated anytime." }
      ]
    }
  },
  {
    type: "CTA",
    displayName: "Call to Action",
    propsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        ctaText: { type: "string" },
        ctaHref: { type: "string" }
      }
    },
    defaultProps: {
      title: "Ready to get started?",
      description: "Apply your next change in seconds.",
      ctaText: "Start now",
      ctaHref: "/"
    }
  },
  {
    type: "Card",
    displayName: "Card",
    propsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        ctaText: { type: "string" },
        ctaHref: { type: "string" },
        imageUrl: { type: "string" },
        imageAlt: { type: "string" }
      }
    },
    defaultProps: {
      title: "Launch faster",
      description: "Go from idea to published changes in minutes.",
      ctaText: "Learn more",
      ctaHref: "/pricing"
    }
  },
  {
    type: "CardGrid",
    displayName: "Card Grid",
    propsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              ctaText: { type: "string" },
              ctaHref: { type: "string" },
              imageUrl: { type: "string" },
              imageAlt: { type: "string" }
            }
          }
        }
      }
    },
    defaultProps: {
      title: "Explore more",
      cards: [
        { title: "Fast setup", description: "Create and ship updates quickly.", ctaText: "Get started", ctaHref: "/" },
        { title: "Safe updates", description: "Schema-validated edits reduce breakage.", ctaText: "See how", ctaHref: "/pricing" },
        { title: "Team workflow", description: "Collaborate with clear, reviewable changes.", ctaText: "Read guide", ctaHref: "/" }
      ]
    }
  },
  {
    type: "RichText",
    displayName: "Rich Text",
    propsSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } } },
    defaultProps: {
      title: "",
      body: "Add your content here.\n\nUse a second paragraph to break up the text into readable sections."
    }
  },
  {
    type: "Stats",
    displayName: "Stats",
    propsSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        stats: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } } } }
      }
    },
    defaultProps: {
      title: "By the numbers",
      stats: [
        { value: "10k+", label: "Active users" },
        { value: "99.9%", label: "Uptime" },
        { value: "24/7", label: "Support" }
      ]
    }
  },
  {
    type: "TwoColumn",
    displayName: "Two Column",
    propsSchema: {
      type: "object",
      properties: {
        variant: { type: "string", enum: ["default", "accent"] },
        left: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "paragraph", "cta", "image", "video"] },
              text: { type: "string" },
              label: { type: "string" },
              href: { type: "string" },
              src: { type: "string" },
              alt: { type: "string" },
              poster: { type: "string" }
            }
          }
        },
        right: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "paragraph", "cta", "image", "video"] },
              text: { type: "string" },
              label: { type: "string" },
              href: { type: "string" },
              src: { type: "string" },
              alt: { type: "string" },
              poster: { type: "string" }
            }
          }
        }
      }
    },
    defaultProps: {
      variant: "default",
      left: [
        { type: "heading", text: "Built for teams" },
        { type: "paragraph", text: "Ship changes quickly with a clear, reliable workflow." },
        { type: "cta", label: "Learn more", href: "/" }
      ],
      right: [
        { type: "image", src: "/hero-generated.svg", alt: "Team collaborating on a website update" }
      ]
    }
  },
  {
    type: "Footer",
    displayName: "Footer",
    propsSchema: {
      type: "object",
      properties: {
        copyright: { type: "string" },
        columns: { type: "array", items: { type: "object", properties: { title: { type: "string" }, links: { type: "string" } } } }
      }
    },
    defaultProps: {
      copyright: "© 2026 Your Company",
      columns: [
        { title: "Product", links: "Features|/features\nPricing|/pricing" },
        { title: "Company", links: "About|/about\nContact|/contact" }
      ]
    }
  }
]

export function getSiteComponentRegistry() {
  return COMPONENTS.map((entry) => structuredClone(entry))
}
