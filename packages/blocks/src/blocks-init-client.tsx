"use client"

import { useEffect } from "react"
import { initCarousels } from "./blocks/carousel/init"
import { initTabs } from "./blocks/tabs/init"

/**
 * Client component that initializes interactive blocks (carousel, tabs, etc.)
 * after the page renders. Drop this anywhere in the component tree.
 */
export function BlocksInitClient() {
  useEffect(() => {
    initCarousels()
    initTabs()
  })
  return null
}
