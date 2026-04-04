import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractDesignTokens, mapToThemeVariables, normalizeColor, augmentThemeFromComputedStyles } from "./design-tokens.ts"

const FIXTURE_CSS = `
body { color: #333; background-color: #ffffff; font-family: "Inter", sans-serif; }
h1, h2, h3 { color: #1a1a2e; font-family: "Playfair Display", serif; }
.hero { background-color: #f8f9fa; }
.btn-primary { background-color: #2563eb; color: #fff; border-radius: 8px; }
.btn-primary:hover { background-color: #1d4ed8; }
a { color: #2563eb; }
.card { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; }
.footer { background-color: #0f172a; color: #94a3b8; }
p { color: #334155; }
`

describe("normalizeColor", () => {
  it("normalizes 3-char hex to 6-char", () => {
    assert.equal(normalizeColor("#abc"), "#aabbcc")
  })

  it("lowercases hex", () => {
    assert.equal(normalizeColor("#AABBCC"), "#aabbcc")
  })

  it("handles 6-char hex", () => {
    assert.equal(normalizeColor("#2563eb"), "#2563eb")
  })

  it("handles 8-char hex (drops alpha)", () => {
    assert.equal(normalizeColor("#2563ebff"), "#2563eb")
  })

  it("converts rgb() to hex", () => {
    assert.equal(normalizeColor("rgb(37, 99, 235)"), "#2563eb")
  })

  it("converts rgba() to hex (ignores alpha)", () => {
    assert.equal(normalizeColor("rgba(255, 255, 255, 0.5)"), "#ffffff")
  })

  it("converts named colors to hex", () => {
    assert.equal(normalizeColor("white"), "#ffffff")
    assert.equal(normalizeColor("black"), "#000000")
    assert.equal(normalizeColor("red"), "#ff0000")
  })

  it("returns null for transparent", () => {
    assert.equal(normalizeColor("transparent"), null)
  })

  it("returns null for inherit", () => {
    assert.equal(normalizeColor("inherit"), null)
  })

  it("returns null for currentColor", () => {
    assert.equal(normalizeColor("currentColor"), null)
  })

  it("returns null for initial", () => {
    assert.equal(normalizeColor("initial"), null)
  })
})

describe("extractDesignTokens", () => {
  const tokens = extractDesignTokens(FIXTURE_CSS)

  it("extracts hex colors from CSS", () => {
    const values = tokens.colors.map((c) => c.value)
    assert.ok(values.includes("#333333"), "should include #333 normalized")
    assert.ok(values.includes("#ffffff"), "should include #ffffff")
    assert.ok(values.includes("#2563eb"), "should include #2563eb")
  })

  it("classifies colors by property (text vs background vs border)", () => {
    const textColors = tokens.colors.filter(
      (c) => c.usage === "text" || c.usage === "accent",
    )
    const bgColors = tokens.colors.filter(
      (c) => c.usage === "background" || c.usage === "accent",
    )
    const borderColors = tokens.colors.filter((c) => c.usage === "border")

    // #333333 is used as text
    const color333 = tokens.colors.find((c) => c.value === "#333333")
    assert.ok(color333, "should find #333333")
    assert.equal(color333!.usage, "text")

    // #f8f9fa is used as background
    const bgHero = tokens.colors.find((c) => c.value === "#f8f9fa")
    assert.ok(bgHero, "should find #f8f9fa")
    assert.equal(bgHero!.usage, "background")

    // #e5e7eb is used as border
    const borderColor = tokens.colors.find((c) => c.value === "#e5e7eb")
    assert.ok(borderColor, "should find #e5e7eb")
    assert.equal(borderColor!.usage, "border")
  })

  it("marks colors used in both text and background as accent", () => {
    // #2563eb is used as both color (a) and background-color (.btn-primary)
    const brand = tokens.colors.find((c) => c.value === "#2563eb")
    assert.ok(brand, "should find #2563eb")
    assert.equal(brand!.usage, "accent")
  })

  it("counts frequency correctly", () => {
    // #ffffff appears in body bg and .card bg → 2 times
    const white = tokens.colors.find((c) => c.value === "#ffffff")
    assert.ok(white, "should find #ffffff")
    assert.ok(white!.frequency >= 2, `expected >=2, got ${white!.frequency}`)

    // #2563eb appears in btn bg + a color → 2 times
    const brand = tokens.colors.find((c) => c.value === "#2563eb")
    assert.ok(brand, "should find #2563eb")
    assert.ok(brand!.frequency >= 2, `expected >=2, got ${brand!.frequency}`)
  })

  it("sorts by frequency descending", () => {
    for (let i = 1; i < tokens.colors.length; i++) {
      assert.ok(
        tokens.colors[i - 1].frequency >= tokens.colors[i].frequency,
        `colors[${i - 1}].frequency (${tokens.colors[i - 1].frequency}) should be >= colors[${i}].frequency (${tokens.colors[i].frequency})`,
      )
    }
  })

  it("extracts font families", () => {
    assert.ok(tokens.fonts.length >= 2, "should find at least 2 fonts")
    const inter = tokens.fonts.find((f) => f.family === "Inter")
    assert.ok(inter, "should find Inter")
    assert.equal(inter!.usage, "body")

    const playfair = tokens.fonts.find((f) => f.family === "Playfair Display")
    assert.ok(playfair, "should find Playfair Display")
    assert.equal(playfair!.usage, "heading")
  })

  it("extracts border-radius values", () => {
    assert.ok(tokens.radii.length >= 1, "should find radii")
    assert.ok(tokens.radii.includes("8px"), "should include 8px")
    assert.ok(tokens.radii.includes("12px"), "should include 12px")
  })

  it("filters out transparent/inherit", () => {
    const css = `
      .a { color: transparent; background-color: inherit; }
      .b { color: #333; }
    `
    const t = extractDesignTokens(css)
    const values = t.colors.map((c) => c.value)
    assert.ok(!values.includes("transparent"))
    assert.ok(!values.includes("inherit"))
    assert.ok(values.includes("#333333"))
  })

  it("extracts rgb/rgba colors and normalizes to hex", () => {
    const css = `
      .a { color: rgb(255, 0, 0); }
      .b { background-color: rgba(0, 128, 0, 0.5); }
    `
    const t = extractDesignTokens(css)
    const values = t.colors.map((c) => c.value)
    assert.ok(values.includes("#ff0000"), "should normalize rgb to hex")
    assert.ok(values.includes("#008000"), "should normalize rgba to hex")
  })
})

describe("mapToThemeVariables", () => {
  const tokens = extractDesignTokens(FIXTURE_CSS)
  const vars = mapToThemeVariables(tokens)

  it("maps most frequent background to --bg-0", () => {
    assert.ok(vars["--bg-0"], "should have --bg-0")
    // #ffffff is the most frequent background (body + card)
    assert.equal(vars["--bg-0"], "#ffffff")
  })

  it("maps most frequent text color to --text-100", () => {
    assert.ok(vars["--text-100"], "should have --text-100")
    // Darkest text color should be mapped
    const l = hexLightness(vars["--text-100"])
    assert.ok(l < 0.5, "--text-100 should be a dark color")
  })

  it("maps brand color", () => {
    assert.ok(vars["--brand"], "should have --brand")
    // #2563eb is the accent color
    assert.equal(vars["--brand"], "#2563eb")
  })

  it("maps footer-bg to darkest background", () => {
    assert.ok(vars["--footer-bg"], "should have --footer-bg")
    assert.equal(vars["--footer-bg"], "#0f172a")
  })

  it("maps footer-text to lightest text", () => {
    assert.ok(vars["--footer-text"], "should have --footer-text")
  })

  it("maps font variables", () => {
    assert.equal(vars["--font-heading"], "Playfair Display")
    assert.equal(vars["--font-body"], "Inter")
  })

  it("generates brand-hover and brand-fg", () => {
    assert.ok(vars["--brand-hover"], "should have --brand-hover")
    assert.ok(vars["--brand-fg"], "should have --brand-fg")
    // Brand is blue (dark) so brand-fg should be white
    assert.equal(vars["--brand-fg"], "#ffffff")
  })
})

describe("augmentThemeFromComputedStyles", () => {
  it("flips light-theme vars to dark when computed styles show dark backgrounds", () => {
    // Pipeline thought it was a light theme (wrong)
    const theme = {
      "--bg-0": "#ffffff",
      "--heading": "#000000",
      "--text-100": "#000000",
      "--body": "#333333",
      "--brand": "#666666",
    }

    // Computed styles reveal dark backgrounds and light text
    const sectionStyles = [
      {
        container: { backgroundColor: "rgb(24, 24, 24)", display: "flex" },
        heading: { color: "rgb(240, 240, 240)", fontFamily: "Montserrat, sans-serif", fontSize: "48px", fontWeight: "800" },
        bodyText: { color: "rgb(207, 207, 207)", fontFamily: "Montserrat, sans-serif", fontSize: "18px" },
        cta: { backgroundColor: "rgb(231, 71, 33)", color: "rgb(255, 255, 255)" },
      },
      {
        container: { backgroundColor: "rgb(24, 24, 24)", display: "flex" },
        heading: { color: "rgb(240, 240, 240)", fontFamily: "Montserrat, sans-serif", fontSize: "30px", fontWeight: "700" },
      },
    ]

    const result = augmentThemeFromComputedStyles(theme, sectionStyles)

    // Should detect dark theme and override
    assert.ok(hexLightness(result["--bg-0"]!) < 0.15, `--bg-0 should be dark, got ${result["--bg-0"]}`)
    assert.ok(hexLightness(result["--heading"]!) > 0.8, `--heading should be light, got ${result["--heading"]}`)
    assert.ok(hexLightness(result["--body"]!) > 0.7, `--body should be light, got ${result["--body"]}`)
    assert.ok(hexLightness(result["--text-100"]!) > 0.8, `--text-100 should be light, got ${result["--text-100"]}`)

    // Brand should come from CTA background
    assert.equal(result["--brand"], "#e74721", "Brand should be CTA orange")
    assert.ok(result["--brand-hover"], "Should have brand-hover derived from brand")

    // Fonts should be extracted from computed heading styles
    assert.ok(result["--font-heading"]?.includes("Montserrat"), `Font heading should be Montserrat, got ${result["--font-heading"]}`)
  })

  it("preserves correct theme when computed styles agree", () => {
    const theme = {
      "--bg-0": "#ffffff",
      "--heading": "#1a1a2e",
      "--body": "#333333",
      "--brand": "#2563eb",
    }

    // Light theme sections — no dark backgrounds
    const sectionStyles = [
      {
        container: { backgroundColor: "rgb(255, 255, 255)" },
        heading: { color: "rgb(26, 26, 46)", fontFamily: "Inter, sans-serif" },
        bodyText: { color: "rgb(51, 51, 51)" },
      },
    ]

    const result = augmentThemeFromComputedStyles(theme, sectionStyles)

    // Light theme should be preserved
    assert.equal(result["--bg-0"], "#ffffff")
  })
})

describe("CSS variable resolution", () => {
  it("resolves var() references using resolvedCssVars map", () => {
    const css = `
      .hero { background-color: var(--primary-color); color: var(--text-color); }
      .card { border-color: var(--border-color, #e5e7eb); }
    `
    const resolvedVars = {
      "--primary-color": "#2563eb",
      "--text-color": "rgb(26, 26, 46)",
    }
    const tokens = extractDesignTokens(css, resolvedVars)
    const values = tokens.colors.map(c => c.value)
    assert.ok(values.includes("#2563eb"), "should resolve --primary-color to #2563eb")
    assert.ok(values.includes("#1a1a2e"), "should resolve --text-color to hex")
  })

  it("uses fallback value when var is not in resolved map", () => {
    const css = `.card { border-color: var(--unknown-var, #e5e7eb); }`
    const tokens = extractDesignTokens(css, {})
    const values = tokens.colors.map(c => c.value)
    assert.ok(values.includes("#e5e7eb"), "should use fallback value")
  })

  it("works without resolvedCssVars (backward compatible)", () => {
    const css = `.btn { background-color: #2563eb; }`
    const tokens = extractDesignTokens(css)
    assert.equal(tokens.colors.length, 1)
    assert.equal(tokens.colors[0].value, "#2563eb")
  })
})

// Helper used in tests
function hexLightness(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.299 * r + 0.587 * g + 0.114 * b
}
