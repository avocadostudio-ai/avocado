import type { JSX } from "react"
import { resolveHeadingTag } from "@avocadostudio-ai/shared"

function isUrl(value: string) {
  return /^https?:\/\//i.test(value)
}

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
            const icon = typeof row.icon === "string" ? row.icon.trim() : ""
            const description = typeof row.description === "string" ? row.description.trim() : ""
            return (
              <div key={idx} className="stat-item">
                {icon.length > 0 && (
                  isUrl(icon)
                    ? <img className="stat-item__icon" src={icon} alt="" width={32} height={32} loading="lazy" />
                    : <span className="stat-item__icon" aria-hidden="true">{icon}</span>
                )}
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
                {description.length > 0 && (
                  <span
                    className="stat-item__description"
                    data-editable-target={`stats[${idx}].description`}
                    data-editable-target-label={`stats[${idx}].description`}
                    data-editable-label={`stats[${idx}].description`}
                  >
                    {description}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
