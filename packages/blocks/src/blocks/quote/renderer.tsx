import type { JSX } from "react"
import { renderRichTextContent } from "../_shared"

export function Quote(props: Record<string, unknown>): JSX.Element {
  const quote = String(props.quote ?? "")
  const author = String(props.author ?? "")
  const role = String(props.role ?? "")
  const imageUrl = String(props.imageUrl ?? "")

  return (
    <section className="quote-block">
      <div className="section__inner">
        <blockquote className="quote-block__quote">
          <span className="quote-block__mark" aria-hidden="true">&ldquo;</span>
          <div
            className="quote-block__text"
            data-editable-target="quote"
            data-editable-target-label="quote"
            data-editable-label="quote"
          >
            {renderRichTextContent(quote)}
          </div>
        </blockquote>
        {(author.length > 0 || role.length > 0) && (
          <div className="quote-block__attribution">
            {imageUrl.length > 0 && (
              <img className="quote-block__avatar" src={imageUrl} alt={author || "Author"} width={48} height={48} />
            )}
            <div className="quote-block__author-info">
              {author.length > 0 && (
                <span
                  className="quote-block__author"
                  data-editable-target="author"
                  data-editable-target-label="author"
                  data-editable-label="author"
                >
                  {author}
                </span>
              )}
              {role.length > 0 && (
                <span
                  className="quote-block__role"
                  data-editable-target="role"
                  data-editable-target-label="role"
                  data-editable-label="role"
                >
                  {role}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
