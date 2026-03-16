import type { JSX } from "react"
import { rendererBlockTypes, type RendererBlockType } from "./block-types.ts"
import { Hero } from "./hero/renderer.tsx"
import { FeatureGrid } from "./feature-grid/renderer.tsx"
import { Testimonials } from "./testimonials/renderer.tsx"
import { FAQAccordion } from "./faq-accordion/renderer.tsx"
import { CTA } from "./cta/renderer.tsx"
import { Card } from "./card/renderer.tsx"
import { CardGrid } from "./card-grid/renderer.tsx"
import { RichText } from "./rich-text/renderer.tsx"
import { Stats } from "./stats/renderer.tsx"
import { TwoColumn } from "./two-column/renderer.tsx"
import { Footer } from "./footer/renderer.tsx"
import { SiteHeader } from "./site-header/renderer.tsx"
import { Embed } from "./embed/renderer.tsx"
import { Banner } from "./banner/renderer.tsx"
import { Carousel } from "./carousel/renderer.tsx"
import { Gallery } from "./gallery/renderer.tsx"
import { Tabs } from "./tabs/renderer.tsx"
import { Table } from "./table/renderer.tsx"
import { Quote } from "./quote/renderer.tsx"
import { Video } from "./video/renderer.tsx"

export const renderers: Record<RendererBlockType, (props: Record<string, unknown>) => JSX.Element | null> = {
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
  Footer,
  SiteHeader,
  Embed,
  Banner,
  Carousel,
  Gallery,
  Tabs,
  Table,
  Quote,
  Video
}

export const rendererTypes = [...rendererBlockTypes]

export function isRendererBlockType(value: string): value is RendererBlockType {
  return rendererBlockTypes.includes(value as RendererBlockType)
}
