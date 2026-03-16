import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"

export function FeatureGrid(props: Record<string, unknown>) {
  const items = Array.isArray(props.features) ? props.features : []
  const HeadingTag = resolveHeadingTag("FeatureGrid", props) as keyof JSX.IntrinsicElements
  return (
    <section>
      <div className="section__inner">
        <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </HeadingTag>
        <ul className="feature-grid">
          {items.map((item, idx) => {
            const row = (item ?? {}) as Record<string, unknown>
            return (
              <li key={idx} className="feature-card">
                <strong
                  data-editable-target={`features[${idx}].title`}
                  data-editable-target-label={`features[${idx}].title`}
                  data-editable-label={`features[${idx}].title`}
                >
                  {String(row.title ?? "")}
                </strong>
                <p
                  data-editable-target={`features[${idx}].description`}
                  data-editable-target-label={`features[${idx}].description`}
                  data-editable-label={`features[${idx}].description`}
                >
                  {String(row.description ?? "")}
                </p>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
