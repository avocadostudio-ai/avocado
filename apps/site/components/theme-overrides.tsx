import type { SiteConfig } from "@avocadostudio-ai/shared"

/** Sanitize a CSS value to prevent injection. Only allows safe characters. */
function safeCssValue(value: string): string | null {
  // Strip anything that could break out of CSS context
  if (/[<>{};]|\/\*|url\s*\(/i.test(value)) return null
  return value.trim()
}

/** Validate CSS custom property name (must start with --) */
function safeCssProperty(key: string): string | null {
  if (!/^--[a-zA-Z0-9-]+$/.test(key)) return null
  return key
}

/**
 * Injects CSS custom property overrides extracted during site migration.
 * Renders a <style> tag with :root overrides so all blocks inherit the migrated theme.
 */
export function ThemeOverrides({ siteConfig }: { siteConfig: SiteConfig }) {
  const overrides = siteConfig.themeOverrides
  if (!overrides || Object.keys(overrides).length === 0) return null

  const declarations = Object.entries(overrides)
    .map(([k, v]) => {
      const prop = safeCssProperty(k)
      const val = safeCssValue(v)
      return prop && val ? `  ${prop}: ${val};` : null
    })
    .filter(Boolean)

  if (declarations.length === 0) return null

  const css = `:root {\n${declarations.join("\n")}\n}`
  return <style dangerouslySetInnerHTML={{ __html: css }} />
}
