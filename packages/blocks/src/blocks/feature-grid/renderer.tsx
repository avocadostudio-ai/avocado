import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"

function isUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

export function FeatureGrid(props: Record<string, unknown>) {
  const items = Array.isArray(props.features) ? props.features : []
  const columns = String(props.columns ?? "3")
  const HeadingTag = resolveHeadingTag("FeatureGrid", props) as keyof JSX.IntrinsicElements
  return (
    <section>
      <div className="section__inner">
        <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </HeadingTag>
        <ul className={`feature-grid${columns !== "3" ? ` feature-grid--${columns}-col` : ""}`}>
          {items.map((item, idx) => {
            const row = (item ?? {}) as Record<string, unknown>
            const icon = typeof row.icon === "string" ? row.icon.trim() : ""
            return (
              <li key={idx} className="feature-card">
                {icon.length > 0 && (
                  isUrl(icon)
                    ? <img className="feature-card__icon" src={icon} alt="" width={40} height={40} loading="lazy" />
                    : <span className="feature-card__icon" aria-hidden="true">{icon}</span>
                )}
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
