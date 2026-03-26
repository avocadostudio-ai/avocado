import type { JSX } from "react"
import { renderInline, PrimaryButton } from "../_shared"

const variantClass: Record<string, string> = {
  info: "banner--info",
  success: "banner--success",
  warning: "banner--warning",
}

export function Banner(props: Record<string, unknown>): JSX.Element {
  const text = String(props.text ?? "")
  const variant = String(props.variant ?? "info")
  const ctaText = String(props.ctaText ?? "")
  const ctaHref = String(props.ctaHref ?? "")

  return (
    <section className={`banner ${variantClass[variant] ?? variantClass.info}`}>
      <div className="banner__inner section__inner">
        <p className="banner__text" data-editable-target="text" data-editable-target-label="text" data-editable-label="text">
          {renderInline(text)}
        </p>
        {ctaText.length > 0 && ctaHref.length > 0 && (
          <PrimaryButton href={ctaHref} className="banner__cta" data-editable-target="ctaText" data-editable-target-label="ctaText" data-editable-label="ctaText">
            {ctaText}
          </PrimaryButton>
        )}
      </div>
    </section>
  )
}
