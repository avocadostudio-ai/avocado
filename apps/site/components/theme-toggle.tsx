"use client"

import { useEffect, useState } from "react"
import { Moon, Sun } from "lucide-react"

const SITE_THEME_STORAGE_KEY = "site-theme-v1"

export function SiteThemeToggle() {
  const [darkMode, setDarkMode] = useState(false)

  useEffect(() => {
    const stored = window.sessionStorage.getItem(SITE_THEME_STORAGE_KEY) ?? window.localStorage.getItem(SITE_THEME_STORAGE_KEY)
    const fallback = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false
    const next = stored === "dark" ? true : stored === "light" ? false : fallback
    setDarkMode(next)
  }, [])

  useEffect(() => {
    const root = window.document.documentElement
    root.classList.toggle("dark", darkMode)
    window.sessionStorage.setItem(SITE_THEME_STORAGE_KEY, darkMode ? "dark" : "light")
    window.localStorage.setItem(SITE_THEME_STORAGE_KEY, darkMode ? "dark" : "light")
  }, [darkMode])

  return (
    <button
      type="button"
      className="site-theme-toggle"
      aria-label={darkMode ? "Switch site to light mode" : "Switch site to dark mode"}
      title={darkMode ? "Light mode" : "Dark mode"}
      onClick={() => setDarkMode((value) => !value)}
    >
      {darkMode ? <Sun aria-hidden="true" className="site-theme-toggle-icon" /> : <Moon aria-hidden="true" className="site-theme-toggle-icon" />}
    </button>
  )
}
