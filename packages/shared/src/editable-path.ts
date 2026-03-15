/**
 * Utilities for working with editable-target path strings.
 *
 * Paths follow the conventions: `imageUrl`, `cards[0].imageUrl`, `right[0].src`.
 */

/** Matches editable paths that point to an image field (imageUrl or indexed .src). */
const IMAGE_PATH_RE = /(imageUrl|\.src)$/i

/** Returns true if the editable path points to an image field. */
export function isImagePath(editablePath: string): boolean {
  return IMAGE_PATH_RE.test(editablePath)
}

/** Derives the companion alt-text path from an image path. Returns the path unchanged if it is not an image path. */
export function toAltPath(editablePath: string): string {
  return editablePath.replace(/imageUrl$/i, "imageAlt").replace(/\.src$/i, ".alt")
}
