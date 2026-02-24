import type { BlockInstance } from "@ai-site-editor/shared"
import { getPreviewWrapperProps } from "@ai-site-editor/preview-adapter"

type PreviewWrapperProps = ReturnType<typeof getPreviewWrapperProps>

function Hero({ previewWrapperProps, ...props }: Record<string, unknown> & { previewWrapperProps?: PreviewWrapperProps }) {
  const mergedClassName = ["hero", previewWrapperProps?.className].filter(Boolean).join(" ")
  return (
    <section {...previewWrapperProps} className={mergedClassName}>
      <div className="hero__inner">
        <h1>{String(props.heading ?? "")}</h1>
        <p>{String(props.subheading ?? "")}</p>
        <a href={String(props.ctaHref ?? "#")}>{String(props.ctaText ?? "")}</a>
      </div>
    </section>
  )
}

function FeatureGrid(props: Record<string, unknown>) {
  const items = Array.isArray(props.features) ? props.features : []
  return (
    <section>
      <h2>{String(props.title ?? "")}</h2>
      <ul>
        {items.map((item, idx) => {
          const row = (item ?? {}) as Record<string, unknown>
          return (
            <li key={idx}>
              <strong>{String(row.title ?? "")}</strong> - {String(row.description ?? "")}
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
      <h2>{String(props.title ?? "")}</h2>
      {items.map((item, idx) => {
        const row = (item ?? {}) as Record<string, unknown>
        return (
          <blockquote key={idx}>
            "{String(row.quote ?? "")}" - {String(row.author ?? "")}
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
      <h2>{String(props.title ?? "")}</h2>
      {items.map((item, idx) => {
        const row = (item ?? {}) as Record<string, unknown>
        return (
          <details key={idx}>
            <summary>{String(row.q ?? "")}</summary>
            <p>{String(row.a ?? "")}</p>
          </details>
        )
      })}
    </section>
  )
}

function CTA(props: Record<string, unknown>) {
  return (
    <section>
      <h2>{String(props.title ?? "")}</h2>
      <p>{String(props.description ?? "")}</p>
      <a href={String(props.ctaHref ?? "#")}>{String(props.ctaText ?? "")}</a>
    </section>
  )
}

const renderers = {
  Hero,
  FeatureGrid,
  Testimonials,
  FAQAccordion,
  CTA
} as const

export function BlockRenderer({ block, editorMode }: { block: BlockInstance; editorMode: boolean }) {
  const Renderer = renderers[block.type]
  const previewWrapperProps = getPreviewWrapperProps(editorMode, block.id, block.type)

  if (block.type === "Hero") {
    return <Hero {...block.props} previewWrapperProps={previewWrapperProps} />
  }

  return (
    <div {...previewWrapperProps}>
      <Renderer {...block.props} />
    </div>
  )
}
