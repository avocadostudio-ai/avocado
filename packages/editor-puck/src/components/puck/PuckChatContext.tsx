import { createContext, useContext, type ReactNode } from "react"
import type { ChatPanelProps } from "./types"

const PuckChatContext = createContext<ChatPanelProps | null>(null)

export function PuckChatContextProvider({
  value,
  children,
}: {
  value: ChatPanelProps
  children: ReactNode
}) {
  return <PuckChatContext.Provider value={value}>{children}</PuckChatContext.Provider>
}

export function usePuckChatContext() {
  return useContext(PuckChatContext)
}
