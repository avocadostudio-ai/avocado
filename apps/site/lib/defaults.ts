import { siteNameFallback } from "./navigation"

export const DEFAULT_SITE_ID = process.env.NEXT_PUBLIC_DEFAULT_SITE_ID?.trim() || "my-site"
export const DEFAULT_SESSION = process.env.DRAFT_DEFAULT_SESSION?.trim() || "dev"
export const DEFAULT_SITE_NAME = siteNameFallback(DEFAULT_SITE_ID)
