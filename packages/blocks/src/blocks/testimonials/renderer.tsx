import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"

export function Testimonials(props: Record<string, unknown>) {
  const items = Array.isArray(props.items) ? props.items : []
  const HeadingTag = resolveHeadingTag("Testimonials", props) as keyof JSX.IntrinsicElements
  return (
    <section>
      <div className="section__inner">
        <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </HeadingTag>
        <div className="testimonials-grid">
          {items.map((item, idx) => {
            const row = (item ?? {}) as Record<string, unknown>
            return (
              <blockquote key={idx} className="testimonial-card">
                <span className="testimonial-card__mark" aria-hidden="true">
                  &ldquo;
                </span>
                <p
                  className="testimonial-card__quote"
                  data-editable-target={`items[${idx}].quote`}
                  data-editable-target-label={`items[${idx}].quote`}
                  data-editable-label={`items[${idx}].quote`}
                >
                  {String(row.quote ?? "")}
                </p>
                <footer
                  className="testimonial-card__author"
                  data-editable-target={`items[${idx}].author`}
                  data-editable-target-label={`items[${idx}].author`}
                  data-editable-label={`items[${idx}].author`}
                >
                  &mdash; {String(row.author ?? "")}
                </footer>
              </blockquote>
            )
          })}
        </div>
      </div>
    </section>
  )
}
