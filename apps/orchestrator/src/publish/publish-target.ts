import type { PageDoc, SiteConfig } from "@ai-site-editor/shared"

export type PublishResult = {
  ok: boolean
  slugs: string[]
  deploymentId?: string
  deploymentUrl?: string
  inspectUrl?: string
  error?: string
}

export type PublishStatus = {
  status: "triggered" | "failed" | "ready"
  deploymentId?: string
  vercelState?: string
  inspectUrl?: string
  lastCheckError?: string
}

export interface PublishTarget {
  publish(session: string, pages: PageDoc[], config: SiteConfig): Promise<PublishResult>
  getStatus?(session: string): Promise<PublishStatus | null>
}
