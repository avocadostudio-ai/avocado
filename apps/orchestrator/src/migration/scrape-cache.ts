/**
 * Shared scrape cache — avoids redundant Playwright launches (~5-15s each)
 * when both scrape_url and generate_page_specs tools are called for the same URL.
 *
 * Capped at 10 entries with LRU eviction — each FullPageScrape can be several MB.
 */

import type { FullPageScrape } from "@ai-site-editor/migration-sdk"

const MAX_ENTRIES = 10
const cache = new Map<string, FullPageScrape>()

export function getCachedScrape(url: string): FullPageScrape | undefined {
  return cache.get(url)
}

export function setCachedScrape(url: string, scrape: FullPageScrape): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(url, scrape)
}
