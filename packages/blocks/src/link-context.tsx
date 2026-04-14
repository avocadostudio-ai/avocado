"use client"

import { useSyncExternalStore, type AnchorHTMLAttributes, type ComponentType, type ReactNode } from "react"

export type BlocksLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
}

export type BlocksLinkComponent = ComponentType<BlocksLinkProps>

const DefaultLink: BlocksLinkComponent = (props) => <a {...props} />

// Stored on globalThis so symlink-aware bundlers (Next dev with
// `resolve.symlinks: false`) that load this module twice still share one
// registration — otherwise Provider and Consumer see different React
// contexts and the consumer falls back to the default <a>.
const GLOBAL_KEY = "__ai_site_editor_blocks_link_store__" as const

type Store = {
  component: BlocksLinkComponent
  listeners: Set<() => void>
}

const store: Store =
  ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as Store) ??
  ((globalThis as Record<string, unknown>)[GLOBAL_KEY] = {
    component: DefaultLink,
    listeners: new Set()
  })

function subscribe(listener: () => void) {
  store.listeners.add(listener)
  return () => {
    store.listeners.delete(listener)
  }
}

function getSnapshot(): BlocksLinkComponent {
  return store.component
}

export function setBlocksLinkComponent(component: BlocksLinkComponent) {
  if (store.component === component) return
  store.component = component
  for (const listener of store.listeners) listener()
}

export function BlocksLinkProvider({
  component,
  children
}: {
  component: BlocksLinkComponent
  children: ReactNode
}) {
  // Register synchronously so SSR and first client render pick it up.
  if (store.component !== component) {
    store.component = component
    for (const listener of store.listeners) listener()
  }
  return <>{children}</>
}

export function useBlocksLink(): BlocksLinkComponent {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
