// Named imports trigger each module's registerBlock() side effect
import { heroDefaultProps } from "./hero.ts"
import { featureGridDefaultProps } from "./feature-grid.ts"
import { testimonialsDefaultProps } from "./testimonials.ts"
import { faqAccordionDefaultProps } from "./faq-accordion.ts"
import { ctaDefaultProps } from "./cta.ts"
import { cardDefaultProps } from "./card.ts"
import { cardGridDefaultProps } from "./card-grid.ts"
import { richTextDefaultProps } from "./rich-text.ts"
import { statsDefaultProps } from "./stats.ts"
import { twoColumnDefaultProps } from "./two-column.ts"
import { footerDefaultProps } from "./footer.ts"
import { siteHeaderDefaultProps } from "./site-header.ts"
import { embedDefaultProps } from "./embed.ts"
import { bannerDefaultProps } from "./banner.ts"
import { carouselDefaultProps } from "./carousel.ts"
import { galleryDefaultProps } from "./gallery.ts"
import { tabsDefaultProps } from "./tabs.ts"

import type { BlockType } from "./_registry.ts"

const defaults: Record<string, () => Record<string, unknown>> = {
  Hero: heroDefaultProps,
  FeatureGrid: featureGridDefaultProps,
  Testimonials: testimonialsDefaultProps,
  FAQAccordion: faqAccordionDefaultProps,
  CTA: ctaDefaultProps,
  Card: cardDefaultProps,
  CardGrid: cardGridDefaultProps,
  RichText: richTextDefaultProps,
  Stats: statsDefaultProps,
  TwoColumn: twoColumnDefaultProps,
  Footer: footerDefaultProps,
  SiteHeader: siteHeaderDefaultProps,
  Embed: embedDefaultProps,
  Banner: bannerDefaultProps,
  Carousel: carouselDefaultProps,
  Gallery: galleryDefaultProps,
  Tabs: tabsDefaultProps,
}

const fallback: Record<string, unknown> = {
  title: "Ready to get started?",
  description: "Apply your next change in seconds.",
  ctaText: "Start now",
  ctaHref: "/"
}

export function defaultPropsForType(type: BlockType): Record<string, unknown> {
  return defaults[type]?.() ?? { ...fallback }
}

export { DEFAULT_HEADING_LEVELS, resolveHeadingTag } from "./_helpers.ts"
