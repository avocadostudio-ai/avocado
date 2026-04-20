import type { PageDoc, SiteConfig } from "@ai-site-editor/shared"
import type { ContentSource } from "./content-source.js"
import {
  getSessionDraft,
  getPage as _getPage,
  getSessionPages as _getSessionPages,
  setPage as _setPage,
  removePage as _removePage,
  getSiteConfig as _getSiteConfig,
  setSiteConfig as _setSiteConfig,
  bumpVersion as _bumpVersion,
  pushUndo as _pushUndo,
  pushCappedHistory,
  orderSlugsHomeFirst,
  versions,
  historyUndo,
  historyRedo,
  getHistoryMap
} from "./session-state.js"

export class InMemoryContentSource implements ContentSource {
  async getPage(session: string, slug: string) {
    return _getPage(session, slug)
  }

  async getSessionPages(session: string) {
    return _getSessionPages(session)
  }

  async getSlugs(session: string) {
    return orderSlugsHomeFirst(Array.from(getSessionDraft(session).keys()))
  }

  async getSiteConfig(session: string) {
    return _getSiteConfig(session)
  }

  async setPage(session: string, page: PageDoc) {
    _setPage(session, page)
  }

  async removePage(session: string, slug: string) {
    _removePage(session, slug)
  }

  async setSiteConfig(session: string, config: SiteConfig) {
    _setSiteConfig(session, config)
  }

  async getVersion(session: string) {
    return versions.get(session) ?? 0
  }

  async bumpVersion(session: string) {
    return _bumpVersion(session)
  }

  async pushUndo(session: string, slug: string, snapshot: PageDoc | null) {
    _pushUndo(session, slug, snapshot)
  }

  async popUndo(session: string, slug: string) {
    const undoMap = getHistoryMap(historyUndo, session)
    return undoMap.get(slug)?.pop()
  }

  async pushRedo(session: string, slug: string, snapshot: PageDoc | null) {
    const redoMap = getHistoryMap(historyRedo, session)
    const list = redoMap.get(slug) ?? []
    pushCappedHistory(list, snapshot)
    redoMap.set(slug, list)
  }

  async popRedo(session: string, slug: string) {
    const redoMap = getHistoryMap(historyRedo, session)
    return redoMap.get(slug)?.pop()
  }

  async clearRedo(session: string, slug: string) {
    const redoMap = getHistoryMap(historyRedo, session)
    redoMap.set(slug, [])
  }
}
