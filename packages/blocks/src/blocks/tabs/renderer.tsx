import { useId, type JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"
import { renderRichTextContent } from "../_shared"

export function Tabs(props: Record<string, unknown>): JSX.Element {
  const title = String(props.title ?? "")
  const tabs = Array.isArray(props.tabs) ? props.tabs : []
  const uid = useId()
  const HeadingTag = resolveHeadingTag("Tabs", props) as keyof JSX.IntrinsicElements

  return (
    <section className="tabs-block">
      <div className="section__inner">
        {title.length > 0 && (
          <HeadingTag className="tabs-block__title" data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {title}
          </HeadingTag>
        )}
        <div className="tabs-block__bar-wrap">
        <div className="tabs-block__bar" role="tablist">
          {tabs.map((raw, idx) => {
            const tab = (raw ?? {}) as Record<string, unknown>
            return (
              <button
                key={idx}
                id={`tabs-tab${uid}-${idx}`}
                className={`tabs-block__tab${idx === 0 ? " tabs-block__tab--active" : ""}`}
                role="tab"
                type="button"
                aria-selected={idx === 0 ? "true" : "false"}
                aria-controls={`tabs-panel${uid}-${idx}`}
                data-editable-target={`tabs[${idx}].label`}
                data-editable-target-label={`tabs[${idx}].label`}
                data-editable-label={`tabs[${idx}].label`}
              >
                {String(tab.label ?? "")}
              </button>
            )
          })}
        </div>
        </div>
        {tabs.map((raw, idx) => {
          const tab = (raw ?? {}) as Record<string, unknown>
          const content = String(tab.content ?? "")
          return (
            <div
              key={idx}
              className="tabs-block__panel"
              id={`tabs-panel${uid}-${idx}`}
              role="tabpanel"
              aria-labelledby={`tabs-tab${uid}-${idx}`}
              tabIndex={0}
              style={idx === 0 ? undefined : { display: "none" }}
              data-editable-target={`tabs[${idx}].content`}
              data-editable-target-label={`tabs[${idx}].content`}
              data-editable-label={`tabs[${idx}].content`}
            >
              {content.length > 0 && (
                <div className="tabs-block__content">
                  {renderRichTextContent(content)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
