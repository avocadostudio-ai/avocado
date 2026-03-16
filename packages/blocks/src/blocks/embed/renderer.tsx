import type { JSX } from "react"
import { renderInline } from "../_shared"

const ratioClass: Record<string, string> = {
  "16:9": "embed-block__frame--16-9",
  "4:3": "embed-block__frame--4-3",
  "1:1": "embed-block__frame--1-1",
}

export function Embed(props: Record<string, unknown>): JSX.Element | null {
  const url = String(props.url ?? "")
  const title = String(props.title ?? "")
  const aspectRatio = String(props.aspectRatio ?? "16:9")

  if (!url) {
    return (
      <section className="embed-block">
        <div className="section__inner">
          <p className="embed-block__error">No embed URL provided</p>
        </div>
      </section>
    )
  }

  return (
    <section className="embed-block">
      <div className="section__inner">
        <div className={`embed-block__frame ${ratioClass[aspectRatio] ?? ratioClass["16:9"]}`}>
          <iframe
            src={url}
            title={title || "Embedded content"}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
        {title.length > 0 && (
          <p className="embed-block__caption" data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {renderInline(title)}
          </p>
        )}
      </div>
    </section>
  )
}
