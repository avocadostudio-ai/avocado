import { z } from "zod"
import { registerBlock } from "@avocadostudio-ai/shared"
import { PALETTE_OPTIONS } from "../theme"

// Palette default shared by most template blocks
const DEFAULT_PALETTE = PALETTE_OPTIONS[0]

// ---------------------------------------------------------------------------
// CtfHeroBanner — componentHeroBanner
// ---------------------------------------------------------------------------
registerBlock("CtfHeroBanner", {
  schema: z.object({
    headline: z.string().min(1),
    bodyText: z.string().default(""),
    ctaText: z.string().default(""),
    targetPage: z.string().default("/"),
    imageUrl: z.string().default(""),
    colorPalette: z.enum(PALETTE_OPTIONS as [string, ...string[]]).default(DEFAULT_PALETTE),
    heroSize: z.enum(["full_screen", "fixed_height"]).default("full_screen"),
    imageStyle: z.enum(["full", "partial"]).default("full"),
  }),
  meta: {
    displayName: "Hero Banner",
    description: "Full-bleed hero with headline, body, image background and CTA.",
    category: "content",
    fields: {
      headline: { kind: "text", label: "Headline" },
      bodyText: { kind: "richtext", label: "Body text", multiline: true },
      ctaText: { kind: "text", label: "CTA text" },
      targetPage: { kind: "url", label: "CTA target page" },
      imageUrl: { kind: "image", label: "Background image", inlineEditable: false, imageSpec: { aspectRatio: "landscape", width: 1920, height: 1080 } },
      colorPalette: { kind: "enum", label: "Color palette", options: PALETTE_OPTIONS, inlineEditable: false },
      heroSize: { kind: "enum", label: "Hero size", options: ["full_screen", "fixed_height"], inlineEditable: false },
      imageStyle: { kind: "enum", label: "Image style", options: ["full", "partial"], inlineEditable: false },
    },
  },
})

// ---------------------------------------------------------------------------
// CtfDuplex — componentDuplex
// ---------------------------------------------------------------------------
registerBlock("CtfDuplex", {
  schema: z.object({
    headline: z.string().min(1),
    bodyText: z.string().default(""),
    ctaText: z.string().default(""),
    targetPage: z.string().default("/"),
    imageUrl: z.string().default(""),
    containerLayout: z.enum(["image_left", "image_right"]).default("image_left"),
    colorPalette: z.enum(PALETTE_OPTIONS as [string, ...string[]]).default(DEFAULT_PALETTE),
  }),
  meta: {
    displayName: "Duplex (Image + Text)",
    description: "Two-column section with image on one side and body text on the other.",
    category: "content",
    fields: {
      headline: { kind: "text", label: "Headline" },
      bodyText: { kind: "richtext", label: "Body text", multiline: true },
      ctaText: { kind: "text", label: "CTA text" },
      targetPage: { kind: "url", label: "CTA target page" },
      imageUrl: { kind: "image", label: "Image", inlineEditable: false, imageSpec: { aspectRatio: "landscape", width: 960, height: 720 } },
      containerLayout: { kind: "enum", label: "Layout", options: ["image_left", "image_right"], inlineEditable: false },
      colorPalette: { kind: "enum", label: "Color palette", options: PALETTE_OPTIONS, inlineEditable: false },
    },
  },
})

// ---------------------------------------------------------------------------
// CtfInfoBlock — componentInfoBlock
// ---------------------------------------------------------------------------
registerBlock("CtfInfoBlock", {
  schema: z.object({
    headline: z.string().min(1),
    subline: z.string().default(""),
    body: z.string().default(""),
    icon: z.enum(["markdown", "search", "help"]).default("markdown"),
    colorPalette: z.enum(PALETTE_OPTIONS as [string, ...string[]]).default(DEFAULT_PALETTE),
  }),
  meta: {
    displayName: "Info Block",
    description: "Single informational block with icon, headline, subline and body.",
    category: "content",
    fields: {
      headline: { kind: "text", label: "Headline" },
      subline: { kind: "text", label: "Subline" },
      body: { kind: "richtext", label: "Body", multiline: true },
      icon: { kind: "enum", label: "Icon", options: ["markdown", "search", "help"], inlineEditable: false },
      colorPalette: { kind: "enum", label: "Color palette", options: PALETTE_OPTIONS, inlineEditable: false },
    },
  },
})

// ---------------------------------------------------------------------------
// CtfCta — componentCta
// ---------------------------------------------------------------------------
registerBlock("CtfCta", {
  schema: z.object({
    headline: z.string().min(1),
    subline: z.string().default(""),
    ctaText: z.string().default("Learn more"),
    targetPage: z.string().default("/"),
    imageUrl: z.string().default(""),
    colorPalette: z.enum(PALETTE_OPTIONS as [string, ...string[]]).default(DEFAULT_PALETTE),
  }),
  meta: {
    displayName: "CTA",
    description: "Call-to-action section with headline, subline and button.",
    category: "conversion",
    fields: {
      headline: { kind: "text", label: "Headline" },
      subline: { kind: "text", label: "Subline" },
      ctaText: { kind: "text", label: "CTA text" },
      targetPage: { kind: "url", label: "CTA target" },
      imageUrl: { kind: "image", label: "Background image", inlineEditable: false },
      colorPalette: { kind: "enum", label: "Color palette", options: PALETTE_OPTIONS, inlineEditable: false },
    },
  },
})

// ---------------------------------------------------------------------------
// CtfQuote — componentQuote
// ---------------------------------------------------------------------------
registerBlock("CtfQuote", {
  schema: z.object({
    quote: z.string().min(1),
    imageUrl: z.string().default(""),
    imageAlignment: z.enum(["left", "right"]).default("left"),
    colorPalette: z.enum(PALETTE_OPTIONS as [string, ...string[]]).default(DEFAULT_PALETTE),
  }),
  meta: {
    displayName: "Quote",
    description: "Pull quote section with optional image.",
    category: "content",
    fields: {
      quote: { kind: "richtext", label: "Quote", multiline: true },
      imageUrl: { kind: "image", label: "Image", inlineEditable: false, imageSpec: { aspectRatio: "square", width: 480, height: 480 } },
      imageAlignment: { kind: "enum", label: "Image alignment", options: ["left", "right"], inlineEditable: false },
      colorPalette: { kind: "enum", label: "Color palette", options: PALETTE_OPTIONS, inlineEditable: false },
    },
  },
})

// ---------------------------------------------------------------------------
// CtfTextBlock — componentTextBlock
// ---------------------------------------------------------------------------
registerBlock("CtfTextBlock", {
  schema: z.object({
    headline: z.string().min(1),
    subline: z.string().default(""),
    body: z.string().default(""),
  }),
  meta: {
    displayName: "Text Block",
    description: "Plain text section with headline, subline and body.",
    category: "content",
    fields: {
      headline: { kind: "text", label: "Headline" },
      subline: { kind: "text", label: "Subline" },
      body: { kind: "richtext", label: "Body", multiline: true },
    },
  },
})

// ---------------------------------------------------------------------------
// CtfPerson — topicPerson
// ---------------------------------------------------------------------------
registerBlock("CtfPerson", {
  schema: z.object({
    name: z.string().min(1),
    avatarUrl: z.string().default(""),
    cardStyle: z.enum(["default", "compact"]).default("default"),
    shortBio: z.string().default(""),
  }),
  meta: {
    displayName: "Person",
    description: "Person card with avatar, name, and short bio.",
    category: "content",
    fields: {
      name: { kind: "text", label: "Name" },
      avatarUrl: { kind: "image", label: "Avatar", inlineEditable: false, imageSpec: { aspectRatio: "square", width: 360, height: 360 } },
      cardStyle: { kind: "enum", label: "Card style", options: ["default", "compact"], inlineEditable: false },
      shortBio: { kind: "richtext", label: "Short bio", multiline: true },
    },
  },
})

// ---------------------------------------------------------------------------
// CtfProduct — topicProduct
// ---------------------------------------------------------------------------
registerBlock("CtfProduct", {
  schema: z.object({
    name: z.string().min(1),
    description: z.string().default(""),
    imageUrl: z.string().default(""),
    pricing: z.string().default(""),
    features: z.array(z.object({
      name: z.string(),
      longDescription: z.string().default(""),
    })).default([]),
  }),
  meta: {
    displayName: "Product",
    description: "Product card with image, description, pricing and feature list.",
    category: "content",
    fields: {
      name: { kind: "text", label: "Name" },
      description: { kind: "richtext", label: "Description", multiline: true },
      imageUrl: { kind: "image", label: "Featured image", inlineEditable: false, imageSpec: { aspectRatio: "landscape", width: 960, height: 640 } },
      pricing: { kind: "text", label: "Pricing" },
    },
    listFields: {
      features: {
        label: "Features",
        itemFields: {
          name: { kind: "text", label: "Feature name" },
          longDescription: { kind: "richtext", label: "Description", multiline: true },
        },
      },
    },
  },
})

// ---------------------------------------------------------------------------
// CtfBusinessInfo — topicBusinessInfo
// ---------------------------------------------------------------------------
registerBlock("CtfBusinessInfo", {
  schema: z.object({
    name: z.string().min(1),
    shortDescription: z.string().default(""),
    longDescription: z.string().default(""),
    imageUrl: z.string().default(""),
  }),
  meta: {
    displayName: "Business Info",
    description: "Business / organization info card.",
    category: "content",
    fields: {
      name: { kind: "text", label: "Name" },
      shortDescription: { kind: "text", label: "Short description" },
      longDescription: { kind: "richtext", label: "Long description", multiline: true },
      imageUrl: { kind: "image", label: "Featured image", inlineEditable: false },
    },
  },
})

// ---------------------------------------------------------------------------
// CtfProductTable — componentProductTable
// ---------------------------------------------------------------------------
registerBlock("CtfProductTable", {
  schema: z.object({
    headline: z.string().default(""),
    subline: z.string().default(""),
    products: z.array(z.object({
      name: z.string(),
      description: z.string().default(""),
      pricing: z.string().default(""),
      imageUrl: z.string().default(""),
    })).default([]),
  }),
  meta: {
    displayName: "Product Table",
    description: "Comparison table of multiple products.",
    category: "content",
    fields: {
      headline: { kind: "text", label: "Headline" },
      subline: { kind: "text", label: "Subline" },
    },
    listFields: {
      products: {
        label: "Products",
        itemFields: {
          name: { kind: "text", label: "Name" },
          description: { kind: "richtext", label: "Description", multiline: true },
          pricing: { kind: "text", label: "Pricing" },
          imageUrl: { kind: "image", label: "Image", inlineEditable: false },
        },
      },
    },
  },
})

// ---------------------------------------------------------------------------
// CtfFooter — componentFooter (chrome)
// ---------------------------------------------------------------------------
registerBlock("CtfFooter", {
  schema: z.object({
    copyright: z.string().default(""),
    menuItems: z.array(z.object({
      label: z.string(),
      href: z.string(),
    })).default([]),
  }),
  meta: {
    displayName: "Footer",
    description: "Site footer with copyright and menu links.",
    category: "navigation",
    chrome: true,
    fields: {
      copyright: { kind: "text", label: "Copyright" },
    },
    listFields: {
      menuItems: {
        label: "Menu items",
        itemFields: {
          label: { kind: "text", label: "Label" },
          href: { kind: "url", label: "Link" },
        },
      },
    },
  },
})

export const CTF_BLOCK_TYPES = [
  "CtfHeroBanner",
  "CtfDuplex",
  "CtfInfoBlock",
  "CtfCta",
  "CtfQuote",
  "CtfTextBlock",
  "CtfPerson",
  "CtfProduct",
  "CtfBusinessInfo",
  "CtfProductTable",
  "CtfFooter",
] as const

export type CtfBlockType = (typeof CTF_BLOCK_TYPES)[number]
