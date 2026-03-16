import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"

export function Footer(props: Record<string, unknown>) {
  const columns = Array.isArray(props.columns) ? props.columns : []
  const HeadingTag = resolveHeadingTag("Footer", props) as keyof JSX.IntrinsicElements
  return (
    <footer className="site-footer" data-block-chrome="true">
      <div className="section__inner">
        <div className="site-footer__columns">
          {columns.map((col, idx) => {
            const row = (col ?? {}) as Record<string, unknown>
            const linksRaw = String(row.links ?? "")
            const links = linksRaw
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => {
                const parts = line.split("|")
                return { label: parts[0]?.trim() ?? "", href: parts[1]?.trim() ?? "#" }
              })
            return (
              <div key={idx} className="site-footer__col">
                <HeadingTag
                  data-editable-target={`columns[${idx}].title`}
                  data-editable-target-label={`columns[${idx}].title`}
                  data-editable-label={`columns[${idx}].title`}
                >
                  {String(row.title ?? "")}
                </HeadingTag>
                <ul
                  data-editable-target={`columns[${idx}].links`}
                  data-editable-target-label={`columns[${idx}].links`}
                  data-editable-label={`columns[${idx}].links`}
                >
                  {links.map((link, linkIdx) => (
                    <li key={linkIdx}>
                      <a href={link.href}>{link.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
        <div className="site-footer__copyright" data-editable-target="copyright" data-editable-target-label="copyright" data-editable-label="copyright">
          {String(props.copyright ?? "")}
        </div>
      </div>
    </footer>
  )
}
