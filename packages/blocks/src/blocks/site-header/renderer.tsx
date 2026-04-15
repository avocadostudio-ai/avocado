"use client"

import { useState, useRef, useEffect, useCallback, useId } from "react"
import { BlockImage } from "../_shared"

type NavLink = { label: string; href?: string; children?: NavLink[] }

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function SiteHeader(props: Record<string, unknown>) {
  const siteName = String(props.siteName ?? "Site")
  const logoUrl = String(props.logoUrl ?? "/logo.svg")
  const activePath = typeof props.activePath === "string" ? props.activePath : undefined
  const links: NavLink[] = Array.isArray(props.links)
    ? (props.links as NavLink[]).filter(
        (l) => l && typeof l.label === "string" && (typeof l.href === "string" || Array.isArray(l.children))
      )
    : []

  const [isOpen, setIsOpen] = useState(false)
  const [expandedGroup, setExpandedGroup] = useState<number | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const toggleRef = useRef<HTMLButtonElement | null>(null)
  const menuId = useId()

  const close = useCallback(() => { setIsOpen(false); setExpandedGroup(null) }, [])
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

  const isActive = (href: string | undefined) => {
    if (!activePath || !href) return false
    const clean = href.split("?")[0]
    return clean === activePath
  }

  const hasActiveChild = (link: NavLink) =>
    link.children?.some((c) => isActive(c.href)) ?? false

  return (
    <>
      <header className="site-top-nav" data-block-chrome="true">
        <div className="site-top-nav-inner">
          <a className="site-brand" href={links[0]?.href ?? "/"} data-editable-target="siteName">
            {logoUrl ? <BlockImage className="site-logo" src={logoUrl} alt={`${siteName} logo`} width={38} height={38} data-editable-target="logoUrl" /> : null}
            <span className="site-brand-text">{siteName}</span>
          </a>

          {/* Desktop nav */}
          <nav className="site-nav-links site-nav-links-desktop" aria-label="Primary">
            {links.map((link, i) =>
              link.children?.length ? (
                <div key={`group-${i}`} className="site-nav-dropdown">
                  <button
                    type="button"
                    className={`site-nav-dropdown-trigger${hasActiveChild(link) ? " is-active" : ""}`}
                    data-editable-target={`links[${i}].label`}
                    data-editable-target-label={`links[${i}].label`}
                  >
                    {link.label}
                    <ChevronDown className="site-nav-chevron" />
                  </button>
                  <div className="site-nav-dropdown-menu">
                    {link.children.map((child, j) => (
                      <a
                        key={child.href}
                        href={child.href ?? "#"}
                        className={isActive(child.href) ? "is-active" : undefined}
                        data-editable-target={`links[${i}].children[${j}].label`}
                        data-editable-target-label={`links[${i}].children[${j}].label`}
                      >
                        {child.label}
                      </a>
                    ))}
                  </div>
                </div>
              ) : (
                <a
                  key={link.href}
                  href={link.href ?? "#"}
                  className={isActive(link.href) ? "is-active" : undefined}
                  data-editable-target={`links[${i}].label`}
                  data-editable-target-label={`links[${i}].label`}
                >
                  {link.label}
                </a>
              )
            )}
          </nav>

          {/* Mobile menu */}
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
                {links.map((link, i) =>
                  link.children?.length ? (
                    <div key={`mobile-group-${i}`} className="site-nav-mobile-group">
                      <button
                        type="button"
                        className={`site-nav-mobile-group-trigger${hasActiveChild(link) ? " is-active" : ""}`}
                        aria-expanded={expandedGroup === i}
                        onClick={() => setExpandedGroup(expandedGroup === i ? null : i)}
                        data-editable-target={`links[${i}].label`}
                      >
                        {link.label}
                        <ChevronDown className={`site-nav-chevron${expandedGroup === i ? " is-expanded" : ""}`} />
                      </button>
                      {expandedGroup === i ? (
                        <div className="site-nav-mobile-group-children">
                          {link.children.map((child, j) => (
                            <a
                              key={`mobile-${child.href}`}
                              href={child.href ?? "#"}
                              className={isActive(child.href) ? "is-active" : undefined}
                              data-editable-target={`links[${i}].children[${j}].label`}
                              onClick={close}
                            >
                              {child.label}
                            </a>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <a
                      key={`mobile-${link.href}`}
                      href={link.href ?? "#"}
                      className={isActive(link.href) ? "is-active" : undefined}
                      data-editable-target={`links[${i}].label`}
                      onClick={close}
                    >
                      {link.label}
                    </a>
                  )
                )}
              </nav>
            ) : null}
          </div>
        </div>
      </header>
      {isOpen ? (
        <div className="site-mobile-backdrop" onClick={close} />
      ) : null}
    </>
  )
}
