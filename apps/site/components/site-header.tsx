"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useId, useRef, useState } from "react"
import { SiteThemeToggle } from "./theme-toggle"

type NavItem = {
  href: string
  label: string
  isActive: boolean
}

type SiteHeaderProps = {
  siteName: string
  siteLogo: string
  homeHref: string
  navItems: NavItem[]
}

export function SiteHeader({ siteName, siteLogo, homeHref, navItems }: SiteHeaderProps) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const pathname = usePathname()
  const mobileMenuId = useId()
  const mobileMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setMobileMenuOpen(false)
  }, [pathname])

  useEffect(() => {
    if (!mobileMenuOpen) return

    function handlePointerDown(event: PointerEvent) {
      if (!mobileMenuRef.current?.contains(event.target as Node)) {
        setMobileMenuOpen(false)
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileMenuOpen(false)
    }

    window.addEventListener("pointerdown", handlePointerDown)
    window.addEventListener("keydown", handleEscape)
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown)
      window.removeEventListener("keydown", handleEscape)
    }
  }, [mobileMenuOpen])

  return (
    <header className="site-top-nav">
      <Link className="site-brand" href={homeHref}>
        <img className="site-logo" src={siteLogo} alt={`${siteName} logo`} width={38} height={38} />
        <span className="site-brand-text">{siteName}</span>
      </Link>
      <nav className="site-nav-links site-nav-links-desktop" aria-label="Primary">
        {navItems.map((item) => (
          <Link key={item.href} href={item.href} className={item.isActive ? "is-active" : undefined}>
            {item.label}
          </Link>
        ))}
      </nav>
      <div ref={mobileMenuRef} className={`site-mobile-menu${mobileMenuOpen ? " is-open" : ""}`}>
        <button
          type="button"
          className="site-mobile-menu-button"
          aria-expanded={mobileMenuOpen}
          aria-controls={mobileMenuId}
          aria-label="Toggle navigation menu"
          onClick={() => setMobileMenuOpen((open) => !open)}
        >
          <span className="burger-icon" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </button>
        {mobileMenuOpen ? (
          <nav id={mobileMenuId} className="site-nav-links site-nav-links-mobile" aria-label="Mobile primary">
            {navItems.map((item) => (
              <Link
                key={`mobile-${item.href}`}
                href={item.href}
                className={item.isActive ? "is-active" : undefined}
                onClick={() => setMobileMenuOpen(false)}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
      <SiteThemeToggle />
    </header>
  )
}
