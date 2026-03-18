import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"
import { renderInline, BlockImage } from "../_shared"

const colsClass: Record<string, string> = {
  "2": "gallery__grid--2",
  "3": "gallery__grid--3",
  "4": "gallery__grid--4",
}

export function Gallery(props: Record<string, unknown>): JSX.Element {
  const HeadingTag = resolveHeadingTag("Gallery", props) as keyof JSX.IntrinsicElements
  const title = String(props.title ?? "")
  const columns = String(props.columns ?? "3")
  const images = Array.isArray(props.images) ? props.images : []

  return (
    <section className="gallery">
      <div className="section__inner">
        {title.length > 0 && (
          <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {renderInline(title)}
          </HeadingTag>
        )}
        <div className={`gallery__grid ${colsClass[columns] ?? colsClass["3"]}`}>
          {images.map((raw, idx) => {
            const img = (raw ?? {}) as Record<string, unknown>
            const imageUrl = String(img.imageUrl ?? "")
            const alt = String(img.alt ?? "")
            const caption = String(img.caption ?? "")
            return (
              <figure key={idx} className="gallery__item">
                {imageUrl.length > 0 && (
                  <BlockImage
                    className="gallery__image"
                    src={imageUrl}
                    alt={alt}
                    width={800}
                    height={600}
                    sizes="(max-width: 768px) 100vw, 33vw"
                    loading={idx < 4 ? "eager" : "lazy"}
                  />
                )}
                {caption.length > 0 && (
                  <figcaption
                    className="gallery__caption"
                    data-editable-target={`images[${idx}].caption`}
                    data-editable-target-label={`images[${idx}].caption`}
                    data-editable-label={`images[${idx}].caption`}
                  >
                    {renderInline(caption)}
                  </figcaption>
                )}
              </figure>
            )
          })}
        </div>
      </div>
    </section>
  )
}
