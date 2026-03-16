import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"
import { renderRichTextContent } from "../_shared"

export function RichText(props: Record<string, unknown>) {
  const title = String(props.title ?? "")
  const renderedBody = renderRichTextContent(String(props.body ?? ""))
  const HeadingTag = resolveHeadingTag("RichText", props) as keyof JSX.IntrinsicElements
  return (
    <section className="rich-text">
      <div className="section__inner">
        {title.length > 0 && (
          <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {title}
          </HeadingTag>
        )}
        <div className="rich-text__body" data-editable-target="body" data-editable-target-label="body" data-editable-label="body">
          {renderedBody}
        </div>
      </div>
    </section>
  )
}
