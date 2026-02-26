export type UnsplashImage = {
  url: string
  alt: string
  query: string
}

export type UnsplashResolveOptions = {
  variationIndex?: number
  subjectKeywords?: string[]
  usedImageUrls?: Set<string>
}

type ResolveUnsplashImage = (query: string, options?: UnsplashResolveOptions) => Promise<UnsplashImage | null>

export async function resolveDistinctUnsplashImage(args: {
  query: string
  variationIndex: number
  usedImageUrls: Set<string>
  resolveImage: ResolveUnsplashImage
  maxAttempts?: number
}): Promise<UnsplashImage | null> {
  const maxAttempts = Number.isInteger(args.maxAttempts) && (args.maxAttempts as number) > 0 ? (args.maxAttempts as number) : 5
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = await args.resolveImage(args.query, { variationIndex: args.variationIndex + attempt })
    if (!candidate) return null
    if (args.usedImageUrls.has(candidate.url)) continue
    return candidate
  }
  return null
}
