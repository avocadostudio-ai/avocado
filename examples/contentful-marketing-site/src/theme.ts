import { createTheme } from "@mui/material/styles"

export const CONTAINER_WIDTH = 1260
export const SPACER = 5
export const HEADER_HEIGHT = "9rem"
export const HEADER_HEIGHT_MD = "8rem"

export interface ColorConfig {
  headlineColor: string
  textColor: string
  backgroundColor: string
  buttonColor: "primary" | "secondary"
}

const colorConfigs: Record<string, ColorConfig> = {
  "palette-1. White (#FFFFFF)": {
    headlineColor: "#1B273A",
    textColor: "#414D63",
    backgroundColor: "#fff",
    buttonColor: "primary",
  },
  "palette-2. White Smoke (#FCFCFC)": {
    headlineColor: "#1B273A",
    textColor: "#414D63",
    backgroundColor: "#fcfcfc",
    buttonColor: "primary",
  },
  "palette-3. Light Gray (#F4F4F4)": {
    headlineColor: "#000",
    textColor: "#000",
    backgroundColor: "#f4f4f4",
    buttonColor: "primary",
  },
  "palette-4. Gray (#EAEAEA)": {
    headlineColor: "#000",
    textColor: "#000",
    backgroundColor: "#eaeaea",
    buttonColor: "primary",
  },
  "palette-5. Steel Gray (#BBBBBB)": {
    headlineColor: "#000",
    textColor: "#000",
    backgroundColor: "#bbbbbb",
    buttonColor: "primary",
  },
  "palette-6. Dark Gray (#797979)": {
    headlineColor: "#fff",
    textColor: "#fff",
    backgroundColor: "#797979",
    buttonColor: "secondary",
  },
  "palette-7. Black (#000000)": {
    headlineColor: "#fff",
    textColor: "#bbb",
    backgroundColor: "#000",
    buttonColor: "secondary",
  },
}

export const PALETTE_OPTIONS = Object.keys(colorConfigs)

export function getColorConfigFromPalette(palette: string | undefined): ColorConfig {
  if (!palette) return colorConfigs["palette-1. White (#FFFFFF)"]
  const lookup = palette.startsWith("palette-") ? palette : `palette-${palette}`
  return colorConfigs[lookup] ?? colorConfigs["palette-1. White (#FFFFFF)"]
}

export const marketingTheme = createTheme({
  spacing: SPACER,
  typography: {
    fontFamily: `'Red Hat Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`,
    htmlFontSize: 10,
    h1: { fontSize: "3.8rem", lineHeight: 1.089, fontWeight: 600 },
    h2: { fontSize: "3rem", lineHeight: 1.086, fontWeight: 600 },
    h3: { fontSize: "2.1rem", lineHeight: 1.08, fontWeight: 600 },
    h4: { fontSize: "2.1rem", lineHeight: 1.08, fontWeight: 600 },
    h5: { fontSize: "2.1rem", lineHeight: 1.08, fontWeight: 600 },
    h6: { fontSize: "2.1rem", lineHeight: 1.08, fontWeight: 600 },
    body1: { fontSize: "1.8rem", lineHeight: 1.571 },
    body2: { fontSize: "2rem", lineHeight: 1.571 },
  },
  palette: {
    text: { primary: "#000" },
    primary: { main: "#000" },
    secondary: { main: "#fff" },
    background: { default: "white" },
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          textDecoration: "none",
          boxShadow: "none",
          fontSize: "2.1rem",
          lineHeight: 1.52,
          fontWeight: 500,
        },
        contained: {
          borderRadius: "9px",
          padding: "1.1rem 2.4rem",
          "&:hover, &:focus": {
            boxShadow: "0px 3px 6px #00000029",
            transform: "translateY(-4px)",
          },
        },
      },
    },
    MuiCssBaseline: {
      styleOverrides: {
        html: { fontSize: "10px", minHeight: "100%" },
        body: { minHeight: "100%" },
      },
    },
  },
})
