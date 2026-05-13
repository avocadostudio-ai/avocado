import type { JSX } from "react"
import { resolveHeadingTag } from "@avocadostudio-ai/shared"
import { PrimaryButton, renderRichTextContent, BlockImage } from "../_shared"

function TwoColumnChild({ item, headingTag, pathPrefix }: { item: Record<string, unknown>; headingTag: keyof JSX.IntrinsicElements; pathPrefix: string }) {
  const childType = String(item.type ?? "")
  const HeadingTag = headingTag

  if (childType === "heading") {
    return (
      <HeadingTag data-editable-target="heading" data-editable-target-label="heading" data-editable-label="heading">
        {String(item.text ?? "")}
      </HeadingTag>
    )
  }

  if (childType === "paragraph") {
    const renderedBody = renderRichTextContent(String(item.text ?? ""))
    return (
      <div className="two-column__body" data-editable-target="body" data-editable-target-label="body" data-editable-label="body">
        {renderedBody}
      </div>
    )
  }

  if (childType === "cta") {
    const label = String(item.label ?? "")
    if (!label) return null
    return (
      <div className="two-column__cta">
        <PrimaryButton
          href={String(item.href ?? "#")}
          data-editable-target="ctaText"
          data-editable-target-label="ctaText"
          data-editable-label="ctaText"
        >
          {label}
        </PrimaryButton>
      </div>
    )
  }

  if (childType === "video") {
    const src = String(item.src ?? "")
    const poster = item.poster ? String(item.poster) : undefined
    if (!src) return null
    return (
      <div className="two-column__media">
        <video className="two-column__video" controls playsInline preload="metadata" poster={poster}>
          <source src={src} type="video/mp4" />
        </video>
      </div>
    )
  }

  if (childType === "image") {
    return (
      <div className="two-column__media" data-editable-target={`${pathPrefix}.src`} data-editable-target-label="Image">
        <BlockImage
          className="layout-grid__img"
          src={String(item.src ?? "")}
          alt={String(item.alt ?? "")}
          width={768}
          height={1024}
          sizes="(max-width: 768px) 100vw, 50vw"
          data-editable-label="Image"
        />
      </div>
    )
  }

  return null
}

export function TwoColumn(props: Record<string, unknown>) {
  const leftItems = Array.isArray(props.left) ? props.left as Record<string, unknown>[] : []
  const rightItems = Array.isArray(props.right) ? props.right as Record<string, unknown>[] : []
  const variant = String(props.variant ?? "default")
  const HeadingTag = resolveHeadingTag("TwoColumn", props) as keyof JSX.IntrinsicElements

  const allItems = [...leftItems, ...rightItems]
  const hasVideo = allItems.some((item) => String(item.type ?? "") === "video")
  const accentClass = variant === "accent" || hasVideo ? " two-column--accent" : ""

  return (
    <section className={`two-column${accentClass}`}>
      <div className="section__inner two-column__inner layout-grid layout-grid--balanced">
        <div className="two-column__text layout-grid__col">
          {leftItems.map((item, i) => (
            <TwoColumnChild key={`l-${i}`} item={item} headingTag={HeadingTag} pathPrefix={`left[${i}]`} />
          ))}
        </div>
        <div className="two-column__text layout-grid__col">
          {rightItems.map((item, i) => (
            <TwoColumnChild key={`r-${i}`} item={item} headingTag={HeadingTag} pathPrefix={`right[${i}]`} />
          ))}
        </div>
      </div>
    </section>
  )
}
