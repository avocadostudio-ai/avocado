import type { JSX } from "react"
import { resolveHeadingTag, resolveItemHeadingTag } from "@ai-site-editor/shared"
import { PrimaryButton, BlockImage } from "../_shared"

export function CardGrid(props: Record<string, unknown>) {
  const cards = Array.isArray(props.cards) ? props.cards : []
  const HeadingTag = resolveHeadingTag("CardGrid", props) as keyof JSX.IntrinsicElements
  const ItemHeadingTag = resolveItemHeadingTag("CardGrid", props) as keyof JSX.IntrinsicElements
  return (
    <section className="card-grid-section">
      <div className="section__inner">
        <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </HeadingTag>
        <div className="card-grid">
          {cards.map((item, idx) => {
            const row = (item ?? {}) as Record<string, unknown>
            const imageUrl = typeof row.imageUrl === "string" ? row.imageUrl.trim() : ""
            const imageAlt = typeof row.imageAlt === "string" ? row.imageAlt.trim() : ""
            return (
              <article className="card" key={idx} data-editable-target={`cards[${idx}]`} data-editable-target-label={`cards[${idx}]`} data-editable-label={`cards[${idx}]`}>
                {imageUrl.length > 0 && (
                  <div
                    className="card__image-wrap"
                    data-editable-target={`cards[${idx}].imageUrl`}
                    data-editable-target-label={`cards[${idx}].imageUrl`}
                    data-editable-label={`cards[${idx}].imageUrl`}
                  >
                    <BlockImage
                      src={imageUrl}
                      alt={imageAlt.length > 0 ? imageAlt : "Card image"}
                      className="card__image"
                      width={768}
                      height={512}
                      sizes="(max-width: 768px) 100vw, 33vw"
                      loading="lazy"
                    />
                  </div>
                )}
                <ItemHeadingTag
                  data-editable-target={`cards[${idx}].title`}
                  data-editable-target-label={`cards[${idx}].title`}
                  data-editable-label={`cards[${idx}].title`}
                >
                  {String(row.title ?? "")}
                </ItemHeadingTag>
                <p
                  data-editable-target={`cards[${idx}].description`}
                  data-editable-target-label={`cards[${idx}].description`}
                  data-editable-label={`cards[${idx}].description`}
                >
                  {String(row.description ?? "")}
                </p>
                <PrimaryButton
                  href={String(row.ctaHref ?? "#")}
                  data-editable-target={`cards[${idx}].ctaText`}
                  data-editable-target-label={`cards[${idx}].ctaText`}
                  data-editable-label={`cards[${idx}].ctaText`}
                >
                  {String(row.ctaText ?? "")}
                </PrimaryButton>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
