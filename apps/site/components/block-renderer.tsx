import type { BlockInstance } from "@ai-site-editor/shared"
import { getEditorBlockWrapperProps, type EditorBlockWrapperProps } from "../lib/editor-block-wrapper"
import { PrimaryButton, SecondaryButton } from "./ui/buttons"

function renderInline(text: string) {
  const parts = text.split(/\*\*/)
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : part
  )
}

function Hero({ previewWrapperProps, ...props }: Record<string, unknown> & { previewWrapperProps?: EditorBlockWrapperProps }) {
  const mergedClassName = ["hero", previewWrapperProps?.className].filter(Boolean).join(" ")
  return (
    <section {...previewWrapperProps} className={mergedClassName}>
      <div className="hero__inner">
        <div className="hero__content">
          <h1 data-editable-target="heading" data-editable-target-label="heading" data-editable-label="heading">
            {String(props.heading ?? "")}
          </h1>
          <p data-editable-target="subheading" data-editable-target-label="subheading" data-editable-label="subheading">
            {String(props.subheading ?? "")}
          </p>
          <div className="hero__actions">
            <PrimaryButton
              href={String(props.ctaHref ?? "#")}
              data-editable-target="ctaText"
              data-editable-target-label="ctaText"
              data-editable-label="ctaText"
            >
              {String(props.ctaText ?? "")}
            </PrimaryButton>
            {typeof props.secondaryCtaText === "string" && props.secondaryCtaText.length > 0 && (
              <SecondaryButton
                href={String(props.secondaryCtaHref ?? "#")}
                data-editable-target="secondaryCtaText"
                data-editable-target-label="secondaryCtaText"
                data-editable-label="secondaryCtaText"
              >
                {props.secondaryCtaText}
              </SecondaryButton>
            )}
          </div>
        </div>
        <div className="hero__media" data-editable-target="imageUrl" data-editable-target-label="imageUrl">
          <img
            src={String(props.imageUrl ?? "/hero-generated.svg")}
            alt={String(props.imageAlt ?? "Hero image")}
            data-editable-label="imageUrl"
          />
        </div>
      </div>
    </section>
  )
}

function FeatureGrid(props: Record<string, unknown>) {
  const items = Array.isArray(props.features) ? props.features : []
  return (
    <section>
      <h2 data-editable-label="title">{String(props.title ?? "")}</h2>
      <ul>
        {items.map((item, idx) => {
          const row = (item ?? {}) as Record<string, unknown>
          return (
            <li key={idx} data-editable-target={`features[${idx}]`} data-editable-target-label={`features[${idx}]`}>
              <strong data-editable-label={`features[${idx}].title`}>{String(row.title ?? "")}</strong> -{" "}
              <span data-editable-label={`features[${idx}].description`}>{String(row.description ?? "")}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Testimonials(props: Record<string, unknown>) {
  const items = Array.isArray(props.items) ? props.items : []
  return (
    <section>
      <h2 data-editable-label="title">{String(props.title ?? "")}</h2>
      <div className="testimonials-grid">
        {items.map((item, idx) => {
          const row = (item ?? {}) as Record<string, unknown>
          return (
            <blockquote
              key={idx}
              className="testimonial-card"
              data-editable-target={`items[${idx}]`}
              data-editable-target-label={`items[${idx}]`}
            >
              <span className="testimonial-card__mark" aria-hidden="true">&ldquo;</span>
              <p className="testimonial-card__quote" data-editable-label={`items[${idx}].quote`}>
                {String(row.quote ?? "")}
              </p>
              <footer className="testimonial-card__author" data-editable-label={`items[${idx}].author`}>
                &mdash; {String(row.author ?? "")}
              </footer>
            </blockquote>
          )
        })}
      </div>
    </section>
  )
}

function FAQAccordion(props: Record<string, unknown>) {
  const items = Array.isArray(props.items) ? props.items : []
  return (
    <section>
      <h2 data-editable-label="title">{String(props.title ?? "")}</h2>
      {items.map((item, idx) => {
        const row = (item ?? {}) as Record<string, unknown>
        return (
          <details key={idx} data-editable-target={`items[${idx}]`} data-editable-target-label={`items[${idx}]`}>
            <summary data-editable-label={`items[${idx}].q`}>{String(row.q ?? "")}</summary>
            <p data-editable-label={`items[${idx}].a`}>{String(row.a ?? "")}</p>
          </details>
        )
      })}
    </section>
  )
}

function CTA(props: Record<string, unknown>) {
  return (
    <section>
      <h2 data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
        {String(props.title ?? "")}
      </h2>
      <p data-editable-target="description" data-editable-target-label="description" data-editable-label="description">
        {String(props.description ?? "")}
      </p>
      <a
        href={String(props.ctaHref ?? "#")}
        data-editable-target="ctaText"
        data-editable-target-label="ctaText"
        data-editable-label="ctaText"
      >
        {String(props.ctaText ?? "")}
      </a>
    </section>
  )
}

function Card(props: Record<string, unknown>) {
  return (
    <article className="card">
      <h3 data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
        {String(props.title ?? "")}
      </h3>
      <p data-editable-target="description" data-editable-target-label="description" data-editable-label="description">
        {String(props.description ?? "")}
      </p>
      <a
        href={String(props.ctaHref ?? "#")}
        data-editable-target="ctaText"
        data-editable-target-label="ctaText"
        data-editable-label="ctaText"
      >
        {String(props.ctaText ?? "")}
      </a>
    </article>
  )
}

function CardGrid(props: Record<string, unknown>) {
  const cards = Array.isArray(props.cards) ? props.cards : []
  return (
    <section>
      <h2 data-editable-label="title">{String(props.title ?? "")}</h2>
      <div className="card-grid">
        {cards.map((item, idx) => {
          const row = (item ?? {}) as Record<string, unknown>
          return (
            <article className="card" key={idx} data-editable-target={`cards[${idx}]`} data-editable-target-label={`card ${idx + 1}`}>
              <h3 data-editable-label={`cards[${idx}].title`}>{String(row.title ?? "")}</h3>
              <p data-editable-label={`cards[${idx}].description`}>{String(row.description ?? "")}</p>
              <a href={String(row.ctaHref ?? "#")} data-editable-label={`cards[${idx}].ctaText`}>
                {String(row.ctaText ?? "")}
              </a>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function RichText(props: Record<string, unknown>) {
  const title = String(props.title ?? "")
  const body = String(props.body ?? "")
  const paragraphs = body.split(/\n\n+/).filter(Boolean)
  return (
    <section className="rich-text">
      {title.length > 0 && (
        <h2
          data-editable-target="title"
          data-editable-target-label="title"
          data-editable-label="title"
        >
          {title}
        </h2>
      )}
      <div
        className="rich-text__body"
        data-editable-target="body"
        data-editable-target-label="body"
        data-editable-label="body"
      >
        {paragraphs.map((para, idx) => (
          <p key={idx}>{renderInline(para)}</p>
        ))}
      </div>
    </section>
  )
}

const renderers = {
  Hero,
  FeatureGrid,
  Testimonials,
  FAQAccordion,
  CTA,
  Card,
  CardGrid,
  RichText
} as const

export function BlockRenderer({ block, editorMode }: { block: BlockInstance; editorMode: boolean }) {
  const Renderer = renderers[block.type]
  const previewWrapperProps = getEditorBlockWrapperProps(editorMode, block.id, block.type)

  if (!Renderer) return null

  if (block.type === "Hero") {
    return <Hero {...block.props} previewWrapperProps={previewWrapperProps} />
  }

  return (
    <div {...previewWrapperProps}>
      <Renderer {...block.props} />
    </div>
  )
}
