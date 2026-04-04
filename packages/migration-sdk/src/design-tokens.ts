import type { DesignTokens, ExtractedColor, ExtractedFont, ThemeVariables } from "./types.ts"

// ── Named CSS colors (common subset) ──

const NAMED_COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  navy: "#000080",
  teal: "#008080",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00ff00",
  aqua: "#00ffff",
  fuchsia: "#ff00ff",
  coral: "#ff7f50",
  tomato: "#ff6347",
  salmon: "#fa8072",
  gold: "#ffd700",
  khaki: "#f0e68c",
  plum: "#dda0dd",
  orchid: "#da70d6",
  tan: "#d2b48c",
  crimson: "#dc143c",
  indigo: "#4b0082",
  violet: "#ee82ee",
  turquoise: "#40e0d0",
  sienna: "#a0522d",
  peru: "#cd853f",
  linen: "#faf0e6",
  beige: "#f5f5dc",
  ivory: "#fffff0",
  lavender: "#e6e6fa",
  snow: "#fffafa",
  seashell: "#fff5ee",
  mintcream: "#f5fffa",
  azure: "#f0ffff",
  aliceblue: "#f0f8ff",
  ghostwhite: "#f8f8ff",
  whitesmoke: "#f5f5f5",
  honeydew: "#f0fff0",
  floralwhite: "#fffaf0",
  oldlace: "#fdf5e6",
  cornsilk: "#fff8dc",
  bisque: "#ffe4c4",
  wheat: "#f5deb3",
  gainsboro: "#dcdcdc",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  dimgray: "#696969",
  dimgrey: "#696969",
  slategray: "#708090",
  slategrey: "#708090",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
}

const SKIP_VALUES = new Set([
  "transparent",
  "inherit",
  "currentcolor",
  "initial",
  "unset",
  "none",
  "revert",
  "revert-layer",
])

// ── Color normalization ──

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function componentToHex(c: number): string {
  return clamp(c).toString(16).padStart(2, "0")
}

export function normalizeColor(value: string): string | null {
  const v = value.trim().toLowerCase()

  if (SKIP_VALUES.has(v)) return null

  // Hex
  if (v.startsWith("#")) {
    const hex = v.slice(1)
    if (hex.length === 3) {
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    }
    if (hex.length === 4) {
      // #rgba → #rrggbb (drop alpha)
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    }
    if (hex.length === 6) return `#${hex}`
    if (hex.length === 8) {
      // #rrggbbaa → #rrggbb (drop alpha)
      return `#${hex.slice(0, 6)}`
    }
    return null
  }

  // rgb/rgba
  const rgbMatch = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch
    return `#${componentToHex(Number(r))}${componentToHex(Number(g))}${componentToHex(Number(b))}`
  }

  // hsl/hsla
  const hslMatch = v.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/)
  if (hslMatch) {
    const h = Number(hslMatch[1]) / 360
    const s = Number(hslMatch[2]) / 100
    const l = Number(hslMatch[3]) / 100
    const [r, g, b] = hslToRgb(h, s, l)
    return `#${componentToHex(r)}${componentToHex(g)}${componentToHex(b)}`
  }

  // Named color
  if (NAMED_COLORS[v]) return NAMED_COLORS[v]

  return null
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const val = Math.round(l * 255)
    return [val, val, val]
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}

// ── Color lightness for sorting/classification ──

function hexLightness(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.299 * r + 0.587 * g + 0.114 * b
}

// ── Color extraction regex ──

const COLOR_VALUE_RE =
  /#(?:[0-9a-fA-F]{3,8})\b|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-zA-Z]+/g

const COLOR_PROP_RE =
  /(?:^|[{;\s])\s*(color|background-color|background|border-color|border)\s*:\s*([^;}{]+)/gi

const FONT_FAMILY_RE =
  /(?:^|[{;\s])\s*font-family\s*:\s*([^;}{]+)/gi

const BORDER_RADIUS_RE =
  /(?:^|[{;\s])\s*border-radius\s*:\s*([^;}{]+)/gi

// ── Selector context tracking ──

type SelectorContext = { selector: string; body: string }

function parseSelectorBlocks(css: string): SelectorContext[] {
  const blocks: SelectorContext[] = []
  // Simplistic: match `selector { body }` — won't handle nested @ rules perfectly but good enough
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    blocks.push({ selector: m[1].trim(), body: m[2] })
  }
  return blocks
}

function isHeadingSelector(selector: string): boolean {
  return /\bh[1-6]\b|\.heading|\.title/i.test(selector)
}

// ── extractDesignTokens ──

/**
 * Extract design tokens from CSS text.
 * When `resolvedCssVars` is provided (from Playwright getComputedStyle),
 * var() references are resolved to actual values before normalization.
 */
export function extractDesignTokens(css: string, resolvedCssVars?: Record<string, string>): DesignTokens {
  // Pre-process CSS: replace var() references with resolved values
  const processedCss = resolvedCssVars ? resolveVarReferences(css, resolvedCssVars) : css
  const colors = extractColors(processedCss)
  const fonts = extractFonts(processedCss)
  const radii = extractRadii(processedCss)
  return { colors, fonts, radii }
}

/** Replace var(--name) and var(--name, fallback) references with resolved computed values */
function resolveVarReferences(css: string, vars: Record<string, string>): string {
  // Match var(--name) or var(--name, fallback)
  return css.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)/gi, (_match, name: string, fallback?: string) => {
    const resolved = vars[name]
    if (resolved) return resolved
    // Use fallback value if provided, otherwise keep original
    return fallback?.trim() ?? _match
  })
}

function classifyProperty(
  prop: string,
): "text" | "background" | "border" {
  const p = prop.toLowerCase()
  if (p === "color") return "text"
  if (p === "background-color" || p === "background") return "background"
  if (p === "border-color" || p === "border") return "border"
  return "text"
}

function extractColors(css: string): ExtractedColor[] {
  // Accumulate: key = normalized hex, value = { usage set, frequency, property }
  const map = new Map<
    string,
    { usage: Set<string>; frequency: number; property: string }
  >()

  let match: RegExpExecArray | null
  const re = new RegExp(COLOR_PROP_RE.source, "gi")
  while ((match = re.exec(css)) !== null) {
    const prop = match[1]
    const rawValue = match[2].trim()
    const usage = classifyProperty(prop)

    // Extract color values from the declaration value
    const colorRe = new RegExp(COLOR_VALUE_RE.source, "gi")
    let cm: RegExpExecArray | null
    while ((cm = colorRe.exec(rawValue)) !== null) {
      const normalized = normalizeColor(cm[0])
      if (!normalized) continue

      const existing = map.get(normalized)
      if (existing) {
        existing.usage.add(usage)
        existing.frequency++
      } else {
        map.set(normalized, {
          usage: new Set([usage]),
          frequency: 1,
          property: prop.toLowerCase(),
        })
      }
    }
  }

  // Convert to array
  const result: ExtractedColor[] = []
  for (const [value, data] of map) {
    // Pick primary usage: if multiple, prefer text > background > border
    let primaryUsage: ExtractedColor["usage"]
    const usages = data.usage
    if (usages.has("text") && usages.has("background")) {
      primaryUsage = "accent" // appears in both — likely brand/accent
    } else if (usages.has("text")) {
      primaryUsage = "text"
    } else if (usages.has("background")) {
      primaryUsage = "background"
    } else {
      primaryUsage = "border"
    }

    result.push({
      value,
      usage: primaryUsage,
      frequency: data.frequency,
      property: data.property,
    })
  }

  result.sort((a, b) => b.frequency - a.frequency)
  return result
}

function extractFonts(css: string): ExtractedFont[] {
  const blocks = parseSelectorBlocks(css)
  const seen = new Map<string, ExtractedFont>()

  for (const block of blocks) {
    const re = new RegExp(FONT_FAMILY_RE.source, "gi")
    let m: RegExpExecArray | null
    while ((m = re.exec(block.body)) !== null) {
      const raw = m[1].trim()
      // Take the first font family, strip quotes
      const first = raw.split(",")[0].trim().replace(/^["']|["']$/g, "")
      if (!first) continue

      const usage: ExtractedFont["usage"] = isHeadingSelector(block.selector)
        ? "heading"
        : "body"

      // heading takes priority over body if already seen
      if (seen.has(first)) {
        const existing = seen.get(first)!
        if (usage === "heading" && existing.usage !== "heading") {
          existing.usage = "heading"
        }
      } else {
        seen.set(first, { family: first, usage })
      }
    }
  }

  return [...seen.values()]
}

function extractRadii(css: string): string[] {
  const freq = new Map<string, number>()
  const re = new RegExp(BORDER_RADIUS_RE.source, "gi")
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) {
    const val = m[1].trim()
    freq.set(val, (freq.get(val) || 0) + 1)
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([v]) => v)
}

// ── mapToThemeVariables ──

export function mapToThemeVariables(tokens: DesignTokens): ThemeVariables {
  const vars: ThemeVariables = {}

  // Include accent colors in both bg and text pools since they appear in both contexts.
  // For bg, also include light accent colors; for text, include dark accent colors.
  const bgColors = tokens.colors.filter(
    (c) => c.usage === "background" || (c.usage === "accent" && hexLightness(c.value) > 0.5),
  )
  const textColors = tokens.colors.filter(
    (c) => c.usage === "text" || (c.usage === "accent" && hexLightness(c.value) < 0.5),
  )
  // True accent colors: used in both text + background, not near-white/near-black (likely brand)
  const accentColors = tokens.colors.filter(
    (c) => c.usage === "accent" && hexLightness(c.value) > 0.08 && hexLightness(c.value) < 0.85,
  )

  // Sort backgrounds by lightness descending (lightest first)
  const bgByLightness = [...bgColors].sort(
    (a, b) => hexLightness(b.value) - hexLightness(a.value),
  )
  // Sort texts by lightness ascending (darkest first)
  const textByDarkness = [...textColors].sort(
    (a, b) => hexLightness(a.value) - hexLightness(b.value),
  )

  // Detect dark theme: if the most frequent background has lightness < 0.3, the site is dark-themed
  const mostFreqBg = bgColors.length > 0 ? bgColors[0] : null
  const isDarkTheme = mostFreqBg != null && hexLightness(mostFreqBg.value) < 0.3

  // Sort texts by lightness descending (lightest first) — used for dark theme text selection
  const textByLightness = [...textColors].sort(
    (a, b) => hexLightness(b.value) - hexLightness(a.value),
  )

  if (isDarkTheme) {
    // ── Dark theme: backgrounds stay dark, text goes light ──

    // --bg-0: the dark most-frequent background
    if (mostFreqBg) vars["--bg-0"] = mostFreqBg.value

    // --bg-100: a slightly lighter dark shade (not white)
    if (bgByLightness.length > 1) {
      // Find a bg that is lighter than bg-0 but still dark (lightness < 0.5)
      const slightlyLighter = bgByLightness.find(
        (c) => c.value !== mostFreqBg!.value && hexLightness(c.value) < 0.5,
      )
      if (slightlyLighter) {
        vars["--bg-100"] = slightlyLighter.value
      } else {
        // Fallback: adjust bg-0 to be slightly lighter
        vars["--bg-100"] = adjustLightness(mostFreqBg!.value, 0.06)
      }
    }

    // --surface / --surface-border: dark-appropriate values
    if (bgByLightness.length > 0) {
      vars["--surface"] = adjustLightness(mostFreqBg!.value, 0.04)
      vars["--surface-border"] = adjustLightness(mostFreqBg!.value, 0.12)
    }

    // --text-100: lightest text (not darkest!) for dark themes
    if (textByLightness.length > 0) {
      vars["--text-100"] = textByLightness[0].value
    }

    // --text-200: second lightest text
    if (textByLightness.length > 1) {
      vars["--text-200"] = textByLightness[1].value
    }

    // --heading: light text for dark bg
    if (textByLightness.length > 0) {
      vars["--heading"] = textByLightness[0].value
    }

    // --body: lightest text color
    if (textByLightness.length > 0) {
      vars["--body"] = textByLightness[0].value
    }

    // --body-secondary: slightly dimmer light text
    if (textByLightness.length > 1) {
      const secondary = textByLightness.find(
        (c) => hexLightness(c.value) > 0.3 && c.value !== textByLightness[0].value,
      )
      if (secondary) vars["--body-secondary"] = secondary.value
    }

    // --footer-bg: darkest bg (could be even darker than --bg-0)
    if (bgByLightness.length > 0) {
      const darkestBg = bgByLightness[bgByLightness.length - 1]
      vars["--footer-bg"] = darkestBg.value
    }

    // --footer-text: light text for dark footer
    if (textByLightness.length > 0) {
      vars["--footer-text"] = textByLightness[0].value
    }
  } else {
    // ── Light theme: existing logic ──

    // --bg-0: most frequent background, or lightest
    if (bgByLightness.length > 0) {
      vars["--bg-0"] =
        hexLightness(mostFreqBg!.value) > 0.4
          ? mostFreqBg!.value
          : bgByLightness[0].value
    }

    // --bg-100: second most common background (different from bg-0)
    if (bgByLightness.length > 1) {
      const bg0 = vars["--bg-0"]
      const second = bgByLightness.find((c) => c.value !== bg0)
      if (second) vars["--bg-100"] = second.value
    }

    // --text-100: most frequent text color (or darkest)
    if (textByDarkness.length > 0) {
      vars["--text-100"] = textByDarkness[0].value
    }

    // --text-200: second text color
    if (textByDarkness.length > 1) {
      vars["--text-200"] = textByDarkness[1].value
    }

    // --heading: same as text-100 or darkest text
    if (textByDarkness.length > 0) {
      vars["--heading"] = textByDarkness[0].value
    }

    // --body: most frequent text color
    if (textColors.length > 0) {
      // Prefer the most frequent text-only color
      const bodyTexts = tokens.colors.filter((c) => c.usage === "text")
      if (bodyTexts.length > 0) {
        vars["--body"] = bodyTexts[0].value
      } else {
        vars["--body"] = textByDarkness[0].value
      }
    }

    // --body-secondary: lighter body text
    if (textByDarkness.length > 1) {
      // Pick the lightest text color that isn't near-white
      const secondary = [...textByDarkness]
        .reverse()
        .find((c) => hexLightness(c.value) < 0.85)
      if (secondary) vars["--body-secondary"] = secondary.value
    }

    // --footer-bg: darkest background color
    if (bgByLightness.length > 0) {
      const darkestBg = bgByLightness[bgByLightness.length - 1]
      vars["--footer-bg"] = darkestBg.value
    }

    // --footer-text: lightest text color
    if (textByDarkness.length > 0) {
      const lightestText = textByDarkness[textByDarkness.length - 1]
      vars["--footer-text"] = lightestText.value
    }
  }

  // --brand: most frequent accent color, or a color appearing in both text + background
  if (accentColors.length > 0) {
    vars["--brand"] = accentColors[0].value
  } else {
    // Fallback: find a non-neutral color used as text that isn't very dark/light
    const candidate = textColors.find((c) => {
      const l = hexLightness(c.value)
      return l > 0.15 && l < 0.7
    })
    if (candidate) vars["--brand"] = candidate.value
  }

  if (vars["--brand"]) {
    // --brand-hover: slightly darker variant
    vars["--brand-hover"] = adjustLightness(vars["--brand"], -0.08)
    // --brand-subtle: very light version for light themes, darker for dark themes
    vars["--brand-subtle"] = isDarkTheme
      ? adjustLightness(vars["--brand"], -0.15)
      : adjustLightness(vars["--brand"], 0.35)
    // --brand-fg: text on brand background
    vars["--brand-fg"] =
      hexLightness(vars["--brand"]) > 0.5 ? "#000000" : "#ffffff"
  }

  // ── Derived surface/compound variables ──

  // --caption: lighter text for captions/labels
  if (!vars["--caption"]) {
    if (isDarkTheme && textByLightness.length > 1) {
      // For dark themes, pick a mid-lightness text
      const cap = textByLightness.find(c => hexLightness(c.value) > 0.3 && hexLightness(c.value) < 0.7)
      if (cap) vars["--caption"] = cap.value
    } else if (textByDarkness.length > 1) {
      const cap = [...textByDarkness].reverse().find(c => hexLightness(c.value) < 0.65 && hexLightness(c.value) > 0.3)
      if (cap) vars["--caption"] = cap.value
    }
    if (!vars["--caption"]) vars["--caption"] = vars["--body-secondary"] ?? "#64748b"
  }

  // --surface: always set (dark branch may have set it already)
  if (!vars["--surface"]) {
    vars["--surface"] = isDarkTheme
      ? adjustLightness(vars["--bg-0"] ?? "#1a1a1a", 0.04)
      : vars["--bg-100"] ?? "#f8fafc"
  }
  if (!vars["--surface-border"]) {
    vars["--surface-border"] = isDarkTheme
      ? adjustLightness(vars["--bg-0"] ?? "#1a1a1a", 0.12)
      : "#e2e8f0"
  }

  // --border: surface border or derived
  if (!vars["--border"]) vars["--border"] = vars["--surface-border"]

  // --bg-1: alternate background (similar to bg-100)
  if (!vars["--bg-1"]) vars["--bg-1"] = vars["--bg-100"] ?? vars["--bg-0"] ?? "#ffffff"

  // --section-bg: section background
  vars["--section-bg"] = `var(--bg-100)`

  // --card-bg: slightly offset from main bg
  if (!vars["--card-bg"]) vars["--card-bg"] = vars["--surface"] ?? vars["--bg-100"] ?? "#f8fafc"

  // --card-shadow
  vars["--card-shadow"] = isDarkTheme ? "0 1px 3px rgba(0,0,0,0.3)" : "0 1px 3px rgba(0,0,0,0.08)"

  // --hero-bg / --cta-bg: default to bg-0
  if (!vars["--hero-bg"]) vars["--hero-bg"] = `var(--bg-0)`
  if (!vars["--cta-bg"]) vars["--cta-bg"] = `var(--bg-100)`

  // --placeholder-img
  vars["--placeholder-img"] = isDarkTheme ? "#374151" : "#e2e8f0"

  // ── Footer (only set defaults if not already set by dark/light branch) ──
  if (!vars["--footer-heading"]) vars["--footer-heading"] = isDarkTheme ? (vars["--heading"] ?? "#f1f5f9") : "#f1f5f9"
  if (!vars["--footer-link"]) vars["--footer-link"] = vars["--footer-text"] ?? "#94a3b8"
  if (!vars["--footer-link-hover"]) vars["--footer-link-hover"] = isDarkTheme ? "#ffffff" : "#e2e8f0"
  if (!vars["--footer-border"]) vars["--footer-border"] = isDarkTheme ? adjustLightness(vars["--footer-bg"] ?? "#0f172a", 0.06) : "#1e293b"

  // ── Typography ──
  const headingFont = tokens.fonts.find((f) => f.usage === "heading")
  const bodyFont = tokens.fonts.find((f) => f.usage === "body")
  if (headingFont) vars["--font-heading"] = headingFont.family
  if (bodyFont) vars["--font-body"] = bodyFont.family

  // ── Shapes (from extracted border-radius values) ──
  if (tokens.radii.length > 0) {
    const mainRadius = tokens.radii[0] // most frequent
    vars["--radius-btn"] = mainRadius
    vars["--radius-card"] = mainRadius
    vars["--radius-feature"] = mainRadius
  }

  return vars
}

// ── Computed style augmentation ──

/**
 * Override theme variables with actual computed CSS values from section specs.
 * Computed styles (from getComputedStyle in the browser) are more reliable than
 * CSS regex extraction, especially for CMS sites using CSS variables/inline styles.
 */
export function augmentThemeFromComputedStyles(
  theme: ThemeVariables,
  sectionStyles: Array<{
    container: Record<string, string>
    heading?: Record<string, string>
    bodyText?: Record<string, string>
    cta?: Record<string, string>
  }>,
  hoverStates?: Array<{ triggerTarget: string; changedStyles: Record<string, { before: string; after: string }> }>,
): ThemeVariables {
  const result = { ...theme }

  // Collect actual computed colors from sections
  const containerBgs: string[] = []
  const headingColors: string[] = []
  const headingFonts: string[] = []
  const bodyColors: string[] = []
  const bodyFonts: string[] = []
  const ctaBgs: string[] = []
  const ctaColors: string[] = []

  for (const s of sectionStyles) {
    // Container background — skip transparent
    const bg = s.container.backgroundColor ?? ""
    const bgNorm = normalizeColor(bg)
    if (bgNorm && bgNorm !== "#000000") containerBgs.push(bgNorm)
    // Also check shorthand background for solid colors
    const bgFull = s.container.background ?? ""
    if (bgFull && !bgFull.includes("gradient")) {
      const bgFullNorm = normalizeColor(bgFull.split(/\s/)[0])
      if (bgFullNorm) containerBgs.push(bgFullNorm)
    }

    // Heading
    if (s.heading) {
      const hColor = normalizeColor(s.heading.color ?? "")
      if (hColor) headingColors.push(hColor)
      const hFont = s.heading.fontFamily?.split(",")[0].trim().replace(/['"]/g, "")
      if (hFont && hFont !== "inherit" && hFont !== "initial") headingFonts.push(hFont)
    }

    // Body text
    if (s.bodyText) {
      const bColor = normalizeColor(s.bodyText.color ?? "")
      if (bColor) bodyColors.push(bColor)
      const bFont = s.bodyText.fontFamily?.split(",")[0].trim().replace(/['"]/g, "")
      if (bFont && bFont !== "inherit" && bFont !== "initial") bodyFonts.push(bFont)
    }

    // CTA
    if (s.cta) {
      const ctaBg = normalizeColor(s.cta.backgroundColor ?? "")
      if (ctaBg) ctaBgs.push(ctaBg)
      const ctaColor = normalizeColor(s.cta.color ?? "")
      if (ctaColor) ctaColors.push(ctaColor)
    }
  }

  // Detect dark theme from actual computed backgrounds
  // Count dark vs light non-transparent section backgrounds
  const darkBgs = containerBgs.filter(c => hexLightness(c) < 0.3)
  const lightBgs = containerBgs.filter(c => hexLightness(c) > 0.6)
  // Also check heading/body text — on dark themes, text is light
  const lightTexts = [...headingColors, ...bodyColors].filter(c => hexLightness(c) > 0.7)
  const darkTexts = [...headingColors, ...bodyColors].filter(c => hexLightness(c) < 0.3)

  const isDark = (darkBgs.length > lightBgs.length) || (lightTexts.length > darkTexts.length && darkBgs.length > 0)

  // If computed styles reveal a dark theme but the token pipeline didn't detect it,
  // flip the key variables
  if (isDark && hexLightness(result["--bg-0"] ?? "#ffffff") > 0.5) {
    // The token pipeline thought it was light — override with computed data
    const darkBg = mostFrequent(containerBgs.filter(c => hexLightness(c) < 0.3)) ?? "#181818"
    result["--bg-0"] = darkBg
    result["--bg-100"] = adjustLightness(darkBg, 0.04)
    result["--bg-1"] = result["--bg-100"]
    result["--surface"] = adjustLightness(darkBg, 0.04)
    result["--surface-border"] = adjustLightness(darkBg, 0.12)
    result["--border"] = result["--surface-border"]
    result["--card-bg"] = result["--surface"]
    result["--card-shadow"] = "0 1px 3px rgba(0,0,0,0.3)"
    result["--placeholder-img"] = "#374151"
    result["--hero-bg"] = `var(--bg-0)`
    result["--cta-bg"] = `var(--bg-100)`
  }

  // Override text colors with computed values
  if (headingColors.length > 0) {
    const hColor = mostFrequent(headingColors)!
    result["--heading"] = hColor
    result["--text-100"] = hColor
    // On dark theme, body should also be light
    if (isDark) {
      result["--body"] = mostFrequent(bodyColors) ?? hColor
      result["--text-200"] = mostFrequent(bodyColors) ?? adjustLightness(hColor, -0.1)
    }
  }

  if (bodyColors.length > 0 && !isDark) {
    result["--body"] = mostFrequent(bodyColors)!
  }

  // Override brand with actual CTA color (most reliable source of brand color)
  if (ctaBgs.length > 0) {
    // Filter out near-transparent and near-black/white CTA backgrounds
    const colorfulCtas = ctaBgs.filter(c => {
      const l = hexLightness(c)
      return l > 0.08 && l < 0.92
    })
    if (colorfulCtas.length > 0) {
      const brand = mostFrequent(colorfulCtas)!
      result["--brand"] = brand
      result["--brand-hover"] = adjustLightness(brand, -0.08)
      result["--brand-subtle"] = isDark
        ? adjustLightness(brand, -0.15)
        : adjustLightness(brand, 0.35)
      result["--brand-fg"] = hexLightness(brand) > 0.5 ? "#000000" : "#ffffff"
    }
  }

  // Override brand-hover with actual hover state color (from interaction sweep)
  if (hoverStates && hoverStates.length > 0) {
    for (const hs of hoverStates) {
      const bgChange = hs.changedStyles.backgroundColor
      if (bgChange) {
        const hoverColor = normalizeColor(bgChange.after)
        if (hoverColor && hexLightness(hoverColor) > 0.08 && hexLightness(hoverColor) < 0.92) {
          result["--brand-hover"] = hoverColor
          break // Use first valid hover color
        }
      }
    }
  }

  // Override fonts with computed values
  if (headingFonts.length > 0) {
    result["--font-heading"] = mostFrequent(headingFonts)! + ", sans-serif"
  }
  if (bodyFonts.length > 0) {
    result["--font-body"] = mostFrequent(bodyFonts)! + ", sans-serif"
  }

  // Fix footer colors for dark theme
  if (isDark) {
    result["--footer-bg"] = adjustLightness(result["--bg-0"] ?? "#181818", -0.03)
    result["--footer-text"] = result["--heading"] ?? "#f0f0f0"
    result["--footer-heading"] = result["--heading"] ?? "#f0f0f0"
    result["--footer-link"] = result["--body"] ?? result["--heading"] ?? "#cfcfcf"
    result["--footer-link-hover"] = "#ffffff"
    result["--footer-border"] = adjustLightness(result["--footer-bg"]!, 0.06)
  }

  return result
}

/** Find the most frequent value in an array */
function mostFrequent(arr: string[]): string | undefined {
  if (arr.length === 0) return undefined
  const counts = new Map<string, number>()
  for (const v of arr) {
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best = arr[0]
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount) { bestCount = c; best = v }
  }
  return best
}

// ── Lightness adjustment helper ──

function adjustLightness(hex: string, delta: number): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255

  // Convert to HSL
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  let l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max - min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      case b:
        h = ((r - g) / d + 4) / 6
        break
    }
  }

  l = Math.max(0, Math.min(1, l + delta))
  const [nr, ng, nb] = hslToRgb(h, s, l)
  return `#${componentToHex(nr)}${componentToHex(ng)}${componentToHex(nb)}`
}
