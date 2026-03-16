import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"
import { PrimaryButton } from "../_shared"

export function Card(props: Record<string, unknown>) {
  const imageUrl = typeof props.imageUrl === "string" ? props.imageUrl.trim() : ""
  const imageAlt = typeof props.imageAlt === "string" ? props.imageAlt.trim() : ""
  const HeadingTag = resolveHeadingTag("Card", props) as keyof JSX.IntrinsicElements
  return (
    <section>
      <div className="section__inner">
        <article className="card">
          {imageUrl.length > 0 && (
            <div className="card__image-wrap" data-editable-target="imageUrl" data-editable-target-label="image">
              <img src={imageUrl} alt={imageAlt.length > 0 ? imageAlt : "Card image"} className="card__image" loading="lazy" />
            </div>
          )}
          <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {String(props.title ?? "")}
          </HeadingTag>
          <p data-editable-target="description" data-editable-target-label="description" data-editable-label="description">
            {String(props.description ?? "")}
          </p>
          <PrimaryButton href={String(props.ctaHref ?? "#")} data-editable-target="ctaText" data-editable-target-label="ctaText" data-editable-label="ctaText">
            {String(props.ctaText ?? "")}
          </PrimaryButton>
        </article>
      </div>
    </section>
  )
}
