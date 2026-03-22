import imageUrlBuilder from "@sanity/image-url"
import { client } from "./sanity.client"

const builder = imageUrlBuilder(client)

/** Convert a Sanity image reference to a CDN URL */
export function sanityImageUrl(source: unknown): string {
  if (!source || typeof source !== "object") return ""
  const ref = source as { _type?: string; asset?: { _ref?: string } }
  if (ref._type !== "image" || !ref.asset?._ref) return ""
  return builder.image(source).auto("format").url()
}
