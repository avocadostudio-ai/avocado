import type { JSX } from "react"
import { resolveHeadingTag } from "@ai-site-editor/shared"
import { PrimaryButton } from "../_shared"

export function CTA(props: Record<string, unknown>) {
  const HeadingTag = resolveHeadingTag("CTA", props) as keyof JSX.IntrinsicElements
  return (
    <section className="cta-section">
      <div className="section__inner">
        <HeadingTag data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </HeadingTag>
        <p data-editable-target="description" data-editable-target-label="description" data-editable-label="description">
          {String(props.description ?? "")}
        </p>
        <PrimaryButton href={String(props.ctaHref ?? "#")} data-editable-target="ctaText" data-editable-target-label="ctaText" data-editable-label="ctaText">
          {String(props.ctaText ?? "")}
        </PrimaryButton>
      </div>
    </section>
  )
}
