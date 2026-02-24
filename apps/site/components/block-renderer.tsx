import type { BlockInstance } from "@ai-site-editor/shared"
import { getEditorBlockWrapperProps, type EditorBlockWrapperProps } from "../lib/editor-block-wrapper"

function Hero({ previewWrapperProps, ...props }: Record<string, unknown> & { previewWrapperProps?: EditorBlockWrapperProps }) {
  const mergedClassName = ["hero", previewWrapperProps?.className].filter(Boolean).join(" ")
  return (
    <section {...previewWrapperProps} className={mergedClassName}>
      <div className="hero__inner">
        <h1 data-editable-target="heading" data-editable-target-label="heading" data-editable-label="heading">
          {String(props.heading ?? "")}
        </h1>
        <p data-editable-target="subheading" data-editable-target-label="subheading" data-editable-label="subheading">
          {String(props.subheading ?? "")}
        </p>
        <a
          href={String(props.ctaHref ?? "#")}
          data-editable-target="ctaText"
          data-editable-target-label="ctaText"
          data-editable-label="ctaText"
        >
          {String(props.ctaText ?? "")}
        </a>
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
      {items.map((item, idx) => {
        const row = (item ?? {}) as Record<string, unknown>
        return (
          <blockquote key={idx} data-editable-target={`items[${idx}]`} data-editable-target-label={`items[${idx}]`}>
            <span data-editable-label={`items[${idx}].quote`}>"{String(row.quote ?? "")}"</span> -{" "}
            <span data-editable-label={`items[${idx}].author`}>{String(row.author ?? "")}</span>
          </blockquote>
        )
      })}
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
      <h2 data-editable-label="title">{String(props.title ?? "")}</h2>
      <p data-editable-label="description">{String(props.description ?? "")}</p>
      <a href={String(props.ctaHref ?? "#")} data-editable-label="ctaText">
        {String(props.ctaText ?? "")}
      </a>
    </section>
  )
}

function Card(props: Record<string, unknown>) {
  return (
    <article className="card">
      <h3 data-editable-label="title">{String(props.title ?? "")}</h3>
      <p data-editable-label="description">{String(props.description ?? "")}</p>
      <a href={String(props.ctaHref ?? "#")} data-editable-label="ctaText">
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

const renderers = {
  Hero,
  FeatureGrid,
  Testimonials,
  FAQAccordion,
  CTA,
  Card,
  CardGrid
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
