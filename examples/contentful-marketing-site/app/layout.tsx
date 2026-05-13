import type { ReactNode } from "react"
import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter"
import { ThemeProvider } from "@mui/material/styles"
import CssBaseline from "@mui/material/CssBaseline"
import { marketingTheme } from "@/src/theme"

// Side-effect import: registers all Ctf* custom blocks + renderers.
// Must run before any route handler or SSR render so the block manifest
// and renderBlocks() can find them.
import "@/src/blocks/register"

import "@avocadostudio-ai/blocks/styles.css"

export const metadata = {
  title: "Contentful Marketing Site",
  description: "Contentful marketing template — AI editable via ai-site-editor",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@400;500;600;700;800&display=swap"
        />
      </head>
      <body>
        <AppRouterCacheProvider>
          <ThemeProvider theme={marketingTheme}>
            <CssBaseline />
            {children}
          </ThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  )
}
