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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
