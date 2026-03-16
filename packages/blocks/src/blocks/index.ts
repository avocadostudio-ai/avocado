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
import { SiteHeader } from "./site-header/renderer"
import { Embed } from "./embed/renderer"
import { Banner } from "./banner/renderer"
import { Carousel } from "./carousel/renderer"
import { Gallery } from "./gallery/renderer"
import { Tabs } from "./tabs/renderer"
import { Table } from "./table/renderer"
import { Quote } from "./quote/renderer"
import { Video } from "./video/renderer"

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
