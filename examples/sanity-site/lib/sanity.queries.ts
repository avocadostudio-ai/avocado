import groq from "groq"

/** Fetch a single page by slug with all block references resolved */
export const pageBySlugQuery = groq`
  *[_type == "page" && slug.current == $slug][0] {
    _id,
    title,
    "slug": slug.current,
    pageId,
    blocks[]-> {
      _id,
      _type,
      ...
    },
    meta,
    _updatedAt
  }
`

/** Fetch all page slugs for static generation */
export const allSlugsQuery = groq`
  *[_type == "page"] { "slug": slug.current }
`

/** Fetch all pages with resolved blocks */
export const allPagesQuery = groq`
  *[_type == "page"] {
    _id,
    title,
    "slug": slug.current,
    pageId,
    blocks[]-> {
      _id,
      _type,
      ...
    },
    meta,
    _updatedAt
  }
`

/** Fetch site config singleton */
export const siteConfigQuery = groq`
  *[_type == "siteConfig"][0] {
    name,
    logo,
    navLabels
  }
`
