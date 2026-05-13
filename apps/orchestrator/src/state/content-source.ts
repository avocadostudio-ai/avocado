import type { PageDoc, SiteConfig } from "@avocadostudio-ai/shared"

export interface ContentSource {
  getPage(session: string, slug: string): Promise<PageDoc | null>
  getSessionPages(session: string): Promise<PageDoc[]>
  getSlugs(session: string): Promise<string[]>
  getSiteConfig(session: string): Promise<SiteConfig>
  setPage(session: string, page: PageDoc): Promise<void>
  removePage(session: string, slug: string): Promise<void>
  setSiteConfig(session: string, config: SiteConfig): Promise<void>
  getVersion(session: string): Promise<number>
  bumpVersion(session: string): Promise<number>
  pushUndo(session: string, slug: string, snapshot: PageDoc | null): Promise<void>
  popUndo(session: string, slug: string): Promise<PageDoc | null | undefined>
  pushRedo(session: string, slug: string, snapshot: PageDoc | null): Promise<void>
  popRedo(session: string, slug: string): Promise<PageDoc | null | undefined>
  clearRedo(session: string, slug: string): Promise<void>
}
