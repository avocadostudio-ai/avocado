"use client"

import { useState, useRef, useEffect, useCallback, useId } from "react"

type NavLink = { label: string; href: string }

export function SiteHeader(props: Record<string, unknown>) {
  const siteName = String(props.siteName ?? "Site")
  const logoUrl = String(props.logoUrl ?? "/logos/default.svg")
  const activePath = typeof props.activePath === "string" ? props.activePath : undefined
  const links: NavLink[] = Array.isArray(props.links)
    ? (props.links as NavLink[]).filter((l) => l && typeof l.label === "string" && typeof l.href === "string")
    : []

  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((v) => !v), [])

  // Close on popstate (SPA navigation)
  useEffect(() => {
    const handler = () => setIsOpen(false)
    window.addEventListener("popstate", handler)
    return () => window.removeEventListener("popstate", handler)
  }, [])

  // Outside click & Escape key
  useEffect(() => {
    if (!isOpen) return
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setIsOpen(false)
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
      const first = menuRef.current?.querySelector<HTMLElement>("a, button:not([aria-expanded])")
      first?.focus()
    }
  }, [isOpen])

  // Theme toggle
  const [darkMode, setDarkMode] = useState(false)
  useEffect(() => {
    const stored = window.localStorage.getItem("site-theme-v1")
    const fallback = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false
    setDarkMode(stored === "dark" ? true : stored === "light" ? false : fallback)
  }, [])
  useEffect(() => {
    window.document.documentElement.classList.toggle("dark", darkMode)
    window.localStorage.setItem("site-theme-v1", darkMode ? "dark" : "light")
  }, [darkMode])

  const isActive = (href: string) => {
    if (!activePath) return false
    const clean = href.split("?")[0]
    return clean === activePath
  }

  return (
    <>
      <header className="site-top-nav" data-block-chrome="true">
        <a className="site-brand" href={links[0]?.href ?? "/"} data-editable-target="siteName">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="site-logo" src={logoUrl} alt={`${siteName} logo`} width={38} height={38} data-editable-target="logoUrl" />
          <span className="site-brand-text">{siteName}</span>
        </a>
        <nav className="site-nav-links site-nav-links-desktop" aria-label="Primary">
          {links.map((link, i) => (
            <a
              key={link.href}
              href={link.href}
              className={isActive(link.href) ? "is-active" : undefined}
              data-editable-target={`links[${i}].label`}
              data-editable-target-label={`links[${i}].label`}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <button
          type="button"
          className="site-theme-toggle"
          aria-label={darkMode ? "Switch site to light mode" : "Switch site to dark mode"}
          title={darkMode ? "Light mode" : "Dark mode"}
          onClick={() => setDarkMode((v) => !v)}
        >
          {darkMode ? (
            <svg className="site-theme-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></svg>
          ) : (
            <svg className="site-theme-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>
          )}
        </button>
        <div ref={menuRef} className={`site-mobile-menu${isOpen ? " is-open" : ""}`}>
          <button
            ref={toggleRef}
            type="button"
            className="site-mobile-menu-button"
            aria-expanded={isOpen}
            aria-controls={menuId}
            aria-label="Toggle navigation menu"
            onClick={toggle}
          >
            <span className="burger-icon" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </button>
          {isOpen ? (
            <nav id={menuId} className="site-nav-links site-nav-links-mobile" aria-label="Mobile primary">
              {links.map((link, i) => (
                <a
                  key={`mobile-${link.href}`}
                  href={link.href}
                  className={isActive(link.href) ? "is-active" : undefined}
                  data-editable-target={`links[${i}].label`}
                  onClick={close}
                >
                  {link.label}
                </a>
              ))}
            </nav>
          ) : null}
        </div>
      </header>
      {isOpen ? (
        <div className="site-mobile-backdrop" onClick={close} />
      ) : null}
    </>
  )
}
