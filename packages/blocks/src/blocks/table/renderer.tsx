import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"
import { renderInline } from "../_shared"

export function Table(props: Record<string, unknown>): JSX.Element {
  const HeadingTag = resolveHeadingTag("Table", props) as keyof JSX.IntrinsicElements
  const title = String(props.title ?? "")
  const headers = Array.isArray(props.headers) ? props.headers.map(h => String(h ?? "")) : []
  const rows = Array.isArray(props.rows) ? props.rows : []
  const striped = String(props.striped) === "true"

  return (
    <section className="table-block">
      <div className="section__inner">
        {title.length > 0 && (
          <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {renderInline(title)}
          </HeadingTag>
        )}
        <div className="table-block__scroll">
          <table className={`table-block__table${striped ? " table-block__table--striped" : ""}`}>
            {headers.length > 0 && (
              <thead>
                <tr>
                  {headers.map((header, idx) => (
                    <th key={idx} data-editable-target={`headers[${idx}]`}>{renderInline(header)}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.map((rawRow, rowIdx) => {
                const row = Array.isArray(rawRow) ? rawRow : []
                return (
                  <tr key={rowIdx}>
                    {row.map((rawCell, cellIdx) => (
                      <td key={cellIdx} data-editable-target={`rows[${rowIdx}][${cellIdx}]`}>{renderInline(String(rawCell ?? ""))}</td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
