export { blockTypeToCamel as toSanityName, camelToBlockType as sanityNameToBlockType } from "@ai-site-editor/shared"

/** List props stored as Sanity document references (vs inline array objects). */
export const REFERENCE_LISTS: Record<string, Set<string>> = {
  CardGrid: new Set(["cards"]),
}
