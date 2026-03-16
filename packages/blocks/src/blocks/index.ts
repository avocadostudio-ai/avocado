import type { JSX } from "react"
import { Hero } from "./hero/renderer"
import { FeatureGrid } from "./feature-grid/renderer"
import { Testimonials } from "./testimonials/renderer"
import { FAQAccordion } from "./faq-accordion/renderer"
import { CTA } from "./cta/renderer"
import { Card } from "./card/renderer"
import { CardGrid } from "./card-grid/renderer"
import { RichText } from "./rich-text/renderer"
import { Stats } from "./stats/renderer"
import { TwoColumn } from "./two-column/renderer"
import { Footer } from "./footer/renderer"

export const renderers: Record<string, (props: Record<string, unknown>) => JSX.Element | null> = {
  Hero,
  FeatureGrid,
  Testimonials,
  FAQAccordion,
  CTA,
  Card,
  CardGrid,
  RichText,
  Stats,
  TwoColumn,
  Footer
}
