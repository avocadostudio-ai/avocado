import type { JSX } from "react"
import { resolveItemHeadingTag } from "@avocadostudio-ai/shared"
import { renderInline, PrimaryButton, BlockImage } from "../_shared"

export function Carousel(props: Record<string, unknown>): JSX.Element {
  const items = Array.isArray(props.items) ? props.items : []
  const autoplay = String(props.autoplay) === "true"
  const interval = Number(props.interval) || 5000
  const ItemHeadingTag = resolveItemHeadingTag("Carousel", props) as keyof JSX.IntrinsicElements

  return (
    <section
      className="carousel"
      data-autoplay={autoplay ? "true" : undefined}
      data-interval={String(interval)}
    >
      <div className="carousel__inner section__inner">
        <div className="carousel__track">
          {items.map((raw, idx) => {
            const item = (raw ?? {}) as Record<string, unknown>
            const imageUrl = String(item.imageUrl ?? "")
            const imageAlt = String(item.imageAlt ?? "")
            const heading = String(item.heading ?? "")
            const description = String(item.description ?? "")
            const ctaText = String(item.ctaText ?? "")
            const ctaHref = String(item.ctaHref ?? "")
            return (
              <div key={idx} className="carousel__slide">
                {imageUrl.length > 0 && (
                  <BlockImage
                    className="carousel__image"
                    src={imageUrl}
                    alt={imageAlt}
                    width={1200}
                    height={600}
                    sizes="(max-width: 900px) 100vw, 80vw"
                    priority={idx === 0}
                    loading={idx === 0 ? "eager" : "lazy"}
                  />
                )}
                {(heading.length > 0 || description.length > 0 || ctaText.length > 0) && (
                  <div className="carousel__caption">
                    {heading.length > 0 && (
                      <ItemHeadingTag
                        data-editable-target={`items[${idx}].heading`}
                        data-editable-target-label={`items[${idx}].heading`}
                        data-editable-label={`items[${idx}].heading`}
                      >
                        {renderInline(heading)}
                      </ItemHeadingTag>
                    )}
                    {description.length > 0 && (
                      <p
                        data-editable-target={`items[${idx}].description`}
                        data-editable-target-label={`items[${idx}].description`}
                        data-editable-label={`items[${idx}].description`}
                      >
                        {renderInline(description)}
                      </p>
                    )}
                    {ctaText.length > 0 && ctaHref.length > 0 && (
                      <PrimaryButton
                        href={ctaHref}
                        className="carousel__cta"
                        data-editable-target={`items[${idx}].ctaText`}
                        data-editable-target-label={`items[${idx}].ctaText`}
                        data-editable-label={`items[${idx}].ctaText`}
                      >
                        {ctaText}
                      </PrimaryButton>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {items.length > 1 && (
          <>
            <button className="carousel__btn carousel__btn--prev" aria-label="Previous slide" type="button">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            <button className="carousel__btn carousel__btn--next" aria-label="Next slide" type="button">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
            <div className="carousel__dots">
              {items.map((_, idx) => (
                <button
                  key={idx}
                  className={`carousel__dot${idx === 0 ? " carousel__dot--active" : ""}`}
                  aria-label={`Go to slide ${idx + 1}`}
                  type="button"
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
