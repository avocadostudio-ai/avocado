// Stub for next/image in the Vite editor environment.
// Block renderers import next/image for Next.js optimization;
// in Vite we fall back to a plain <img>.
import { siteOrigin } from "../lib/site-urls"

function resolvePathLikeSrc(src: string): string {
  const trimmed = src.trim()
  if (trimmed.length === 0) return src
  if (/^(https?:\/\/|data:|blob:|\/\/)/i.test(trimmed)) return src
  if (trimmed.startsWith("/")) return `${siteOrigin}${trimmed}`
  return src
}

function resolveStubImageSrc(src: unknown): string | undefined {
  if (typeof src === "string") return resolvePathLikeSrc(src)
  if (src && typeof src === "object" && "src" in src) {
    const nestedSrc = (src as { src?: unknown }).src
    if (typeof nestedSrc === "string") return resolvePathLikeSrc(nestedSrc)
  }
  return undefined
}

export default function StubImage(props: Record<string, unknown>) {
  const { fill, sizes, priority, quality, placeholder, blurDataURL, ...rest } = props
  return <img {...rest} src={resolveStubImageSrc(rest.src)} />
}
