import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"
import { renderRichTextContent } from "../_shared"

export function FAQAccordion(props: Record<string, unknown>) {
  const items = Array.isArray(props.items) ? props.items : []
  const HeadingTag = resolveHeadingTag("FAQAccordion", props) as keyof JSX.IntrinsicElements
  return (
    <section>
      <div className="section__inner">
        <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </HeadingTag>
        {items.map((item, idx) => {
          const row = (item ?? {}) as Record<string, unknown>
          return (
            <details key={idx} className="faq-item">
              <summary
                data-editable-target={`items[${idx}].q`}
                data-editable-target-label={`items[${idx}].q`}
                data-editable-label={`items[${idx}].q`}
              >
                {String(row.q ?? "")}
              </summary>
              <div
                className="faq-item__answer"
                data-editable-target={`items[${idx}].a`}
                data-editable-target-label={`items[${idx}].a`}
                data-editable-label={`items[${idx}].a`}
              >
                {renderRichTextContent(String(row.a ?? ""))}
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}
