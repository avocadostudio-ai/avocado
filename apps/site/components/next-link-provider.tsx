"use client"

import NextLink from "next/link"
import type { ReactNode } from "react"
import { BlocksLinkProvider, type BlocksLinkComponent } from "@ai-site-editor/blocks/link-context"

const EXTERNAL_HREF = /^(?:[a-z][a-z0-9+\-.]*:|\/\/|mailto:|tel:|#)/i

const NextLinkAdapter: BlocksLinkComponent = ({ href, ...rest }) => {
  // Route external, protocol, or hash links through plain <a> — next/link only
  // wants internal pathnames. Everything else goes through next/link so the
  // router can handle prefetch + client-side transitions (no white unload flash).
  if (!href || EXTERNAL_HREF.test(href)) {
    return <a href={href} {...rest} />
  }
  return <NextLink href={href} {...rest} />
}

export function NextLinkProvider({ children }: { children: ReactNode }) {
  return <BlocksLinkProvider component={NextLinkAdapter}>{children}</BlocksLinkProvider>
}
