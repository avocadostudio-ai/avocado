import "./globals.css"
import type { Metadata } from "next"
import type { ReactNode } from "react"
import { DEFAULT_SITE_DESCRIPTION } from "../lib/seo"

export const metadata: Metadata = {
  title: { default: "Avocado Stories", template: "%s · Avocado Stories" },
  description: DEFAULT_SITE_DESCRIPTION,
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg"
  }
}

// Inline script that runs before first paint to prevent dark mode flash.
// Reads the stored theme preference and applies the `dark` class immediately.
const themeScript = `(function(){try{var t=localStorage.getItem('site-theme-v1');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}})()`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
