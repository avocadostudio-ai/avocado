import "./globals.css"
import type { Metadata } from "next"
import type { ReactNode } from "react"
import { DEFAULT_SITE_DESCRIPTION } from "../lib/seo"
import { DEFAULT_SITE_NAME } from "../lib/defaults"
import { RouterLinkInterceptor } from "../components/router-link-interceptor"

export const metadata: Metadata = {
  title: { default: DEFAULT_SITE_NAME, template: `%s · ${DEFAULT_SITE_NAME}` },
  description: DEFAULT_SITE_DESCRIPTION,
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg"
  }
}

// Inline script that runs before first paint to prevent dark mode flash.
// Reads the stored theme preference and applies the `dark` class immediately.
// In an editor iframe (cross-origin), localStorage is isolated and may have
// stale values. Skip it and follow system preference only so the preview
// matches what a fresh visitor sees.
const themeScript = `(function(){try{var e=window.parent!==window;var t=e?null:localStorage.getItem('site-theme-v1');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}})()`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning style={{ background: "var(--bg-0, #faf9f5)" }}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body style={{ background: "var(--bg-0, #faf9f5)" }}>
        <RouterLinkInterceptor />
        {children}
      </body>
    </html>
  )
}
