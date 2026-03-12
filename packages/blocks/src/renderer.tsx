import type { AnchorHTMLAttributes, JSX, ReactNode } from "react"
import type { BlockInstance } from "@ai-site-editor/shared"

function decodeSoftHyphenEntities(input: string) {
  return input
    .replace(/&amp;shy;/gi, "&shy;")
    .replace(/&shy;|&#0*173;|&#x0*ad;/gi, "\u00AD")
}

function normalizeSoftHyphenEntities<T>(value: T): T {
  if (typeof value === "string") {
    return decodeSoftHyphenEntities(value) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSoftHyphenEntities(item)) as T
  }
  if (value && typeof value === "object") {
    const normalized: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      normalized[key] = normalizeSoftHyphenEntities(nestedValue)
    }
    return normalized as T
  }
  return value
}

type ButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
  children: ReactNode
}

function PrimaryButton({ href, children, className, ...rest }: ButtonProps) {
  return (
    <a href={href} className={["btn-primary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </a>
  )
}

function SecondaryButton({ href, children, className, ...rest }: ButtonProps) {
  return (
    <a href={href} className={["btn-secondary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </a>
  )
}

function renderInline(text: string) {
  const tokens: Array<string | JSX.Element> = []
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*|\[(.+?)\]\((.+?)\)/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) tokens.push(text.slice(last, match.index))
    if (match[1] !== undefined) {
      tokens.push(<strong key={match.index}>{match[1]}</strong>)
    } else if (match[2] !== undefined) {
      tokens.push(<em key={match.index}>{match[2]}</em>)
    } else if (match[3] !== undefined && match[4] !== undefined) {
      tokens.push(
        <a key={match.index} href={match[4]}>
          {match[3]}
        </a>
      )
    }
    last = match.index + match[0].length
  }
  if (last < text.length) tokens.push(text.slice(last))
  return tokens
}

function normalizeRichTextBody(input: string) {
  return input
    .replace(/\r\n?/g, "\n")
    // Fix run-on sentence joins like "requested.Here's" -> "requested. Here's".
    .replace(/([.!?])([A-Z])/g, "$1 $2")
    // Avoid excessive blank lines while preserving paragraph breaks.
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function renderRichTextBlock(block: string, idx: number) {
  const lines = block
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) return null

  const headingMatch = /^(#{1,6})\s+(.+)$/.exec(lines[0])
  if (headingMatch) {
    const heading = <h3 key={`${idx}-heading`}>{renderInline(headingMatch[2].trim())}</h3>
    const remainder = lines.slice(1).join(" ").trim()
    if (!remainder) return heading
    return [
      heading,
      <p key={`${idx}-paragraph`}>{renderInline(remainder)}</p>
    ]
  }

  const unorderedItems = lines
    .map((line) => /^\s*[-*+•]\s+(.+)$/.exec(line)?.[1]?.trim() ?? null)
    .filter((line): line is string => !!line && line.length > 0)
  if (unorderedItems.length === lines.length) {
    return (
      <ul key={idx}>
        {unorderedItems.map((item, itemIdx) => (
          <li key={itemIdx}>{renderInline(item)}</li>
        ))}
      </ul>
    )
  }

  const orderedItems = lines
    .map((line) => /^\s*\d+[.)]\s+(.+)$/.exec(line)?.[1]?.trim() ?? null)
    .filter((line): line is string => !!line && line.length > 0)
  if (orderedItems.length === lines.length) {
    return (
      <ol key={idx}>
        {orderedItems.map((item, itemIdx) => (
          <li key={itemIdx}>{renderInline(item)}</li>
        ))}
      </ol>
    )
  }

  return <p key={idx}>{renderInline(block)}</p>
}

function renderRichTextContent(input: string) {
  const body = normalizeRichTextBody(input)
  const blocks = body
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
  return blocks.map((block, idx) => renderRichTextBlock(block, idx))
}

function Hero(props: Record<string, unknown>) {
  const imagePosition = String(props.imagePosition ?? "right") === "left" ? "left" : "right"
  const heroClass = imagePosition === "left" ? "hero hero--image-left" : "hero hero--image-right"
  return (
    <section className={heroClass}>
      <div className="section__inner hero__inner">
        <div className="hero__content">
          <h1 data-editable-target="heading" data-editable-target-label="heading" data-editable-label="heading">
            {String(props.heading ?? "")}
          </h1>
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

function FeatureGrid(props: Record<string, unknown>) {
  const items = Array.isArray(props.features) ? props.features : []
  return (
    <section>
      <div className="section__inner">
        <h2 data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </h2>
        <ul className="feature-grid">
          {items.map((item, idx) => {
            const row = (item ?? {}) as Record<string, unknown>
            return (
              <li key={idx} className="feature-card">
                <strong
                  data-editable-target={`features[${idx}].title`}
                  data-editable-target-label={`features[${idx}].title`}
                  data-editable-label={`features[${idx}].title`}
                >
                  {String(row.title ?? "")}
                </strong>
                <p
                  data-editable-target={`features[${idx}].description`}
                  data-editable-target-label={`features[${idx}].description`}
                  data-editable-label={`features[${idx}].description`}
                >
                  {String(row.description ?? "")}
                </p>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}

function Testimonials(props: Record<string, unknown>) {
  const items = Array.isArray(props.items) ? props.items : []
  return (
    <section>
      <div className="section__inner">
        <h2 data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </h2>
        <div className="testimonials-grid">
          {items.map((item, idx) => {
            const row = (item ?? {}) as Record<string, unknown>
            return (
              <blockquote key={idx} className="testimonial-card">
                <span className="testimonial-card__mark" aria-hidden="true">
                  &ldquo;
                </span>
                <p
                  className="testimonial-card__quote"
                  data-editable-target={`items[${idx}].quote`}
                  data-editable-target-label={`items[${idx}].quote`}
                  data-editable-label={`items[${idx}].quote`}
                >
                  {String(row.quote ?? "")}
                </p>
                <footer
                  className="testimonial-card__author"
                  data-editable-target={`items[${idx}].author`}
                  data-editable-target-label={`items[${idx}].author`}
                  data-editable-label={`items[${idx}].author`}
                >
                  &mdash; {String(row.author ?? "")}
                </footer>
              </blockquote>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function FAQAccordion(props: Record<string, unknown>) {
  const items = Array.isArray(props.items) ? props.items : []
  return (
    <section>
      <div className="section__inner">
        <h2 data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </h2>
        {items.map((item, idx) => {
          const row = (item ?? {}) as Record<string, unknown>
          return (
            <details key={idx} className="faq-item">
              <summary
                data-editable-target={`items[${idx}].q`}
                data-editable-target-label={`items[${idx}].q`}
                data-editable-label={`items[${idx}].q`}
              >
                {String(row.q ?? "")}
              </summary>
              <p
                data-editable-target={`items[${idx}].a`}
                data-editable-target-label={`items[${idx}].a`}
                data-editable-label={`items[${idx}].a`}
              >
                {String(row.a ?? "")}
              </p>
            </details>
          )
        })}
      </div>
    </section>
  )
}

function CTA(props: Record<string, unknown>) {
  return (
    <section className="cta-section">
      <div className="section__inner">
        <h2 data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </h2>
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

function Card(props: Record<string, unknown>) {
  const imageUrl = typeof props.imageUrl === "string" ? props.imageUrl.trim() : ""
  const imageAlt = typeof props.imageAlt === "string" ? props.imageAlt.trim() : ""
  return (
    <section>
      <div className="section__inner">
        <article className="card">
          {imageUrl.length > 0 && (
            <div className="card__image-wrap" data-editable-target="imageUrl" data-editable-target-label="image">
              <img src={imageUrl} alt={imageAlt.length > 0 ? imageAlt : "Card image"} className="card__image" loading="lazy" />
            </div>
          )}
          <h3 data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {String(props.title ?? "")}
          </h3>
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

function CardGrid(props: Record<string, unknown>) {
  const cards = Array.isArray(props.cards) ? props.cards : []
  return (
    <section className="card-grid-section">
      <div className="section__inner">
        <h2 data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
          {String(props.title ?? "")}
        </h2>
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
                    <img
                      src={imageUrl}
                      alt={imageAlt.length > 0 ? imageAlt : "Card image"}
                      className="card__image"
                      loading="lazy"
                    />
                  </div>
                )}
                <h3
                  data-editable-target={`cards[${idx}].title`}
                  data-editable-target-label={`cards[${idx}].title`}
                  data-editable-label={`cards[${idx}].title`}
                >
                  {String(row.title ?? "")}
                </h3>
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

function RichText(props: Record<string, unknown>) {
  const title = String(props.title ?? "")
  const renderedBody = renderRichTextContent(String(props.body ?? ""))
  return (
    <section className="rich-text">
      <div className="section__inner">
        {title.length > 0 && (
          <h2 data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {title}
          </h2>
        )}
        <div className="rich-text__body" data-editable-target="body" data-editable-target-label="body" data-editable-label="body">
          {renderedBody}
        </div>
      </div>
    </section>
  )
}

function Stats(props: Record<string, unknown>) {
  const title = String(props.title ?? "")
  const items = Array.isArray(props.stats) ? props.stats : []
  return (
    <section className="stats-section">
      <div className="section__inner">
        {title.length > 0 && (
          <h2 data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {title}
          </h2>
        )}
        <div className="stats-grid">
          {items.map((item, idx) => {
            const row = (item ?? {}) as Record<string, unknown>
            return (
              <div key={idx} className="stat-item">
                <span
                  className="stat-item__value"
                  data-editable-target={`stats[${idx}].value`}
                  data-editable-target-label={`stats[${idx}].value`}
                  data-editable-label={`stats[${idx}].value`}
                >
                  {String(row.value ?? "")}
                </span>
                <span
                  className="stat-item__label"
                  data-editable-target={`stats[${idx}].label`}
                  data-editable-target-label={`stats[${idx}].label`}
                  data-editable-label={`stats[${idx}].label`}
                >
                  {String(row.label ?? "")}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function TwoColumnChild({ item }: { item: Record<string, unknown> }) {
  const childType = String(item.type ?? "")

  if (childType === "heading") {
    return (
      <h2 data-editable-target="heading" data-editable-target-label="heading" data-editable-label="heading">
        {String(item.text ?? "")}
      </h2>
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
      <div className="two-column__media" data-editable-target="imageUrl" data-editable-target-label="Image">
        <img
          src={String(item.src ?? "")}
          alt={String(item.alt ?? "")}
          data-editable-label="Image"
        />
      </div>
    )
  }

  return null
}

function TwoColumn(props: Record<string, unknown>) {
  const leftItems = Array.isArray(props.left) ? props.left as Record<string, unknown>[] : []
  const rightItems = Array.isArray(props.right) ? props.right as Record<string, unknown>[] : []
  const variant = String(props.variant ?? "default")

  const allItems = [...leftItems, ...rightItems]
  const hasVideo = allItems.some((item) => String(item.type ?? "") === "video")
  const accentClass = variant === "accent" || hasVideo ? " two-column--accent" : ""

  return (
    <section className={`two-column${accentClass}`}>
      <div className="section__inner two-column__inner">
        <div className="two-column__text">
          {leftItems.map((item, i) => (
            <TwoColumnChild key={`l-${i}`} item={item} />
          ))}
        </div>
        <div className="two-column__text">
          {rightItems.map((item, i) => (
            <TwoColumnChild key={`r-${i}`} item={item} />
          ))}
        </div>
      </div>
    </section>
  )
}

function Footer(props: Record<string, unknown>) {
  const columns = Array.isArray(props.columns) ? props.columns : []
  return (
    <footer className="site-footer">
      <div className="section__inner">
        <div className="site-footer__columns">
          {columns.map((col, idx) => {
            const row = (col ?? {}) as Record<string, unknown>
            const linksRaw = String(row.links ?? "")
            const links = linksRaw
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => {
                const parts = line.split("|")
                return { label: parts[0]?.trim() ?? "", href: parts[1]?.trim() ?? "#" }
              })
            return (
              <div key={idx} className="site-footer__col">
                <h4
                  data-editable-target={`columns[${idx}].title`}
                  data-editable-target-label={`columns[${idx}].title`}
                  data-editable-label={`columns[${idx}].title`}
                >
                  {String(row.title ?? "")}
                </h4>
                <ul
                  data-editable-target={`columns[${idx}].links`}
                  data-editable-target-label={`columns[${idx}].links`}
                  data-editable-label={`columns[${idx}].links`}
                >
                  {links.map((link, linkIdx) => (
                    <li key={linkIdx}>
                      <a href={link.href}>{link.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
        <div className="site-footer__copyright" data-editable-target="copyright" data-editable-target-label="copyright" data-editable-label="copyright">
          {String(props.copyright ?? "")}
        </div>
      </div>
    </footer>
  )
}

const renderers: Record<string, (props: Record<string, unknown>) => JSX.Element | null> = {
  Hero,
  FeatureGrid,
  Testimonials,
  FAQAccordion,
  CTA,
  Card,
  CardGrid,
  RichText,
  Stats,
  TwoColumn,
  Footer
}

export function SharedBlockRenderer({ block }: { block: BlockInstance }) {
  const Renderer = renderers[block.type]
  if (!Renderer) return null
  const normalizedProps = normalizeSoftHyphenEntities(block.props)
  return <Renderer {...normalizedProps} />
}
