import type { JSX } from "react"
import { renderRichTextContent } from "../_shared"

export function Tabs(props: Record<string, unknown>): JSX.Element {
  const tabs = Array.isArray(props.tabs) ? props.tabs : []

  return (
    <section className="tabs-block">
      <div className="section__inner">
        <div className="tabs-block__bar-wrap">
        <div className="tabs-block__bar" role="tablist">
          {tabs.map((raw, idx) => {
            const tab = (raw ?? {}) as Record<string, unknown>
            return (
              <button
                key={idx}
                className={`tabs-block__tab${idx === 0 ? " tabs-block__tab--active" : ""}`}
                role="tab"
                type="button"
                aria-selected={idx === 0 ? "true" : "false"}
                aria-controls={`tabs-panel-${idx}`}
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
              id={`tabs-panel-${idx}`}
              role="tabpanel"
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
