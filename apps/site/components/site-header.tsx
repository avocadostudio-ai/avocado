"use client"

import Image from "next/image"
import Link from "next/link"
import { SiteThemeToggle } from "./theme-toggle"
import { useMobileMenu } from "../hooks/use-mobile-menu"
import type { NavItem } from "../lib/navigation"

type SiteHeaderProps = {
  siteName: string
  siteLogo: string
  homeHref: string
  navItems: NavItem[]
}

export function SiteHeader({ siteName, siteLogo, homeHref, navItems }: SiteHeaderProps) {
  const { isOpen, toggle, close, menuRef, toggleRef, menuId } = useMobileMenu()

  return (
    <>
      <header className="site-top-nav">
        <Link className="site-brand" href={homeHref}>
          <Image className="site-logo" src={siteLogo} alt={`${siteName} logo`} width={38} height={38} unoptimized />
          <span className="site-brand-text">{siteName}</span>
        </Link>
        <nav className="site-nav-links site-nav-links-desktop" aria-label="Primary">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href} className={item.isActive ? "is-active" : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <SiteThemeToggle />
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
              {navItems.map((item) => (
                <Link
                  key={`mobile-${item.href}`}
                  href={item.href}
                  className={item.isActive ? "is-active" : undefined}
                  onClick={close}
                >
                  {item.label}
                </Link>
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
