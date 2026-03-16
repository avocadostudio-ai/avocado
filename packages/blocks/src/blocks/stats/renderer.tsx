import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"

export function Stats(props: Record<string, unknown>) {
  const title = String(props.title ?? "")
  const items = Array.isArray(props.stats) ? props.stats : []
  const HeadingTag = resolveHeadingTag("Stats", props) as keyof JSX.IntrinsicElements
  return (
    <section className="stats-section">
      <div className="section__inner">
        {title.length > 0 && (
          <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {title}
          </HeadingTag>
        )}
        <div className="stats-grid">
          {items.map((item, idx) => {
            const row = (item ?? {}) as Record<string, unknown>
            return (
              <div key={idx} className="stat-item">
                <span
                  className="stat-item__value"
                  data-editable-target={`stats[${idx}].value`}
                  data-editable-target-label={`stats[${idx}].value`}
                  data-editable-label={`stats[${idx}].value`}
                >
                  {String(row.value ?? "")}
                </span>
                <span
                  className="stat-item__label"
                  data-editable-target={`stats[${idx}].label`}
                  data-editable-target-label={`stats[${idx}].label`}
                  data-editable-label={`stats[${idx}].label`}
                >
                  {String(row.label ?? "")}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
