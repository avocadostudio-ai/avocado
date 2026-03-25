import { createContext, useContext, useState, useCallback, type ReactNode } from "react"
import en, { type LocaleKeys, type LocaleDict } from "./en"
import de from "./de"

export type { LocaleKeys, LocaleDict }
export type Locale = "en" | "de"

const LOCALES: Record<Locale, LocaleDict> = { en, de }
const STORAGE_KEY = "editor-locale"

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
}

function resolveLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === "de") return "de"
  } catch { /* SSR or blocked localStorage */ }
  return "en"
}

export type TFunction = (key: LocaleKeys, vars?: Record<string, string | number>) => string

function makeT(locale: Locale): TFunction {
  return (key, vars) => {
    let str = LOCALES[locale][key] ?? LOCALES.en[key] ?? key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{{${k}}}`, String(v))
      }
    }
    return str
  }
}

/** Non-React helper for pure functions that receive t as a parameter. */
export function getT(locale: Locale): TFunction {
  return makeT(locale)
}

type LocaleContextValue = {
  locale: Locale
  setLocale: (l: Locale) => void
  t: TFunction
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(resolveLocale)

  const setLocale = useCallback((l: Locale) => {
    try { localStorage.setItem(STORAGE_KEY, l) } catch { /* noop */ }
    setLocaleState(l)
  }, [])

  const t = useCallback<TFunction>((key, vars) => {
    let str = LOCALES[locale][key] ?? LOCALES.en[key] ?? key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{{${k}}}`, String(v))
      }
    }
    return str
  }, [locale])

  return (
    <LocaleContext value={{ locale, setLocale, t }}>
      {children}
    </LocaleContext>
  )
}

export function useT() {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error("useT must be used within <LocaleProvider>")
  return ctx
}
