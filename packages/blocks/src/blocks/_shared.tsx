import type { AnchorHTMLAttributes, JSX, ReactNode } from "react"

export { BlockImage, type BlockImageProps } from "./block-image"

export function decodeSoftHyphenEntities(input: string) {
  return input
    .replace(/&amp;shy;/gi, "&shy;")
    .replace(/&shy;|&#0*173;|&#x0*ad;/gi, "\u00AD")
}

export function normalizeSoftHyphenEntities<T>(value: T, seen?: WeakSet<object>): T {
  if (typeof value === "string") {
    return decodeSoftHyphenEntities(value) as T
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSoftHyphenEntities(item, seen)) as T
  }
  if (value && typeof value === "object") {
    // Skip non-plain objects (React elements, class instances, DOM nodes)
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return value
    // Guard against circular references
    const visited = seen ?? new WeakSet()
    if (visited.has(value)) return value
    visited.add(value)
    const normalized: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      normalized[key] = normalizeSoftHyphenEntities(nestedValue, visited)
    }
    return normalized as T
  }
  return value
}

type ButtonProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
  children: ReactNode
}

export function PrimaryButton({ href, children, className, ...rest }: ButtonProps) {
  return (
    <a href={href} className={["btn-primary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </a>
  )
}

export function SecondaryButton({ href, children, className, ...rest }: ButtonProps) {
  return (
    <a href={href} className={["btn-secondary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </a>
  )
}

export function TertiaryButton({ href, children, className, ...rest }: ButtonProps) {
  return (
    <a href={href} className={["btn-tertiary", className].filter(Boolean).join(" ")} {...rest}>
      {children}
    </a>
  )
}

export function renderInline(text: string) {
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

export function normalizeRichTextBody(input: string) {
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

export function renderRichTextContent(input: string) {
  const body = normalizeRichTextBody(input)
  const blocks = body
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
  return blocks.map((block, idx) => renderRichTextBlock(block, idx))
}
