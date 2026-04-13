import type { JSX, ReactNode } from "react"
import { isValidElement } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"
import { renderRichTextContent } from "../_shared"

export function RichText(props: Record<string, unknown>) {
  const title = String(props.title ?? "")
  // Puck's richtext transform passes React elements; plain strings come from
  // the orchestrator/preview. Handle both.
  const body = props.body
  const renderedBody: ReactNode = isValidElement(body)
    ? body
    : renderRichTextContent(String(body ?? ""))
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
