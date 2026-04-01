import type { JSX } from "react"
import { resolveHeadingTag, IMAGE_PLACEHOLDER } from "@ai-site-editor/shared"
import { PrimaryButton, SecondaryButton, BlockImage } from "../_shared"

export function Hero(props: Record<string, unknown>) {
  const rawPosition = String(props.imagePosition ?? "right")
  const isFullWidth = rawPosition === "full"
  const imagePosition = rawPosition === "left" ? "left" : "right"
  const HeadingTag = resolveHeadingTag("Hero", props) as keyof JSX.IntrinsicElements

  const content = (
    <div className="hero__content layout-grid__col">
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
  )

  if (isFullWidth) {
    return (
      <section className="hero hero--full-width">
        <BlockImage
          className="hero__bg-image"
          src={String(props.imageUrl ?? IMAGE_PLACEHOLDER)}
          alt={String(props.imageAlt ?? "Hero image")}
          width={1536}
          height={1024}
          sizes="100vw"
          priority
          data-editable-target="imageUrl"
          data-editable-target-label="Hero block image"
          data-editable-label="Hero block image"
        />
        <div className="section__inner hero__inner">
          {content}
        </div>
      </section>
    )
  }

  const imageLeftClass = imagePosition === "left" ? " layout-grid--image-left hero--image-left" : ""
  return (
    <section className={`hero${imageLeftClass}`}>
      <div className="section__inner hero__inner layout-grid layout-grid--content-heavy">
        {content}
        <div className="hero__media layout-grid__col" data-editable-target="imageUrl" data-editable-target-label="Hero block image">
          <BlockImage
            className="layout-grid__img"
            src={String(props.imageUrl ?? IMAGE_PLACEHOLDER)}
            alt={String(props.imageAlt ?? "Hero image")}
            width={1536}
            height={1024}
            sizes="(max-width: 900px) 100vw, 50vw"
            priority
            data-editable-label="Hero block image"
          />
        </div>
      </div>
    </section>
  )
}
