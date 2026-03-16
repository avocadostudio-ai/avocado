"use client"

import { useEffect, useId, useRef, useState, useCallback } from "react"
import { usePathname } from "next/navigation"

export function useMobileMenu() {
  const [isOpen, setIsOpen] = useState(false)
  const pathname = usePathname()
  const menuId = useId()
  const menuRef = useRef<HTMLDivElement | null>(null)
  const toggleRef = useRef<HTMLButtonElement | null>(null)

  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((v) => !v), [])

  // Close on route change
  useEffect(() => {
    setIsOpen(false)
  }, [pathname])

  // Outside click & Escape key
  useEffect(() => {
    if (!isOpen) return

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false)
        toggleRef.current?.focus()
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleEscape)
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleEscape)
    }
  }, [isOpen])

  // Focus first link when menu opens
  useEffect(() => {
    if (isOpen) {
      const firstLink = menuRef.current?.querySelector<HTMLElement>("a, button:not([aria-expanded])")
      firstLink?.focus()
    }
  }, [isOpen])

  return { isOpen, toggle, close, menuRef, toggleRef, menuId }
}
