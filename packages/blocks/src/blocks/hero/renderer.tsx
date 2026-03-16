import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"
import { PrimaryButton, SecondaryButton } from "../_shared"

export function Hero(props: Record<string, unknown>) {
  const imagePosition = String(props.imagePosition ?? "right") === "left" ? "left" : "right"
  const heroClass = imagePosition === "left" ? "hero hero--image-left" : "hero hero--image-right"
  const HeadingTag = resolveHeadingTag("Hero", props) as keyof JSX.IntrinsicElements
  return (
    <section className={heroClass}>
      <div className="section__inner hero__inner">
        <div className="hero__content">
          <HeadingTag data-editable-target="heading" data-editable-target-label="heading" data-editable-label="heading">
            {String(props.heading ?? "")}
          </HeadingTag>
          <p data-editable-target="subheading" data-editable-target-label="subheading" data-editable-label="subheading">
            {String(props.subheading ?? "")}
          </p>
          <div className="hero__actions">
            <PrimaryButton
              href={String(props.ctaHref ?? "#")}
              data-editable-target="ctaText"
              data-editable-target-label="ctaText"
              data-editable-label="ctaText"
            >
              {String(props.ctaText ?? "")}
            </PrimaryButton>
            {typeof props.secondaryCtaText === "string" && props.secondaryCtaText.length > 0 && (
              <SecondaryButton
                href={String(props.secondaryCtaHref ?? "#")}
                data-editable-target="secondaryCtaText"
                data-editable-target-label="secondaryCtaText"
                data-editable-label="secondaryCtaText"
              >
                {props.secondaryCtaText}
              </SecondaryButton>
            )}
          </div>
        </div>
        <div className="hero__media" data-editable-target="imageUrl" data-editable-target-label="Hero block image">
          <img
            src={String(props.imageUrl ?? "/hero-generated.svg")}
            alt={String(props.imageAlt ?? "Hero image")}
            data-editable-label="Hero block image"
          />
        </div>
      </div>
    </section>
  )
}
