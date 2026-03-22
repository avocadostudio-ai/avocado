import "./globals.css"
import type { Metadata } from "next"
import type { ReactNode } from "react"

export const metadata: Metadata = {
  title: "Strapi Site",
  description: "A Next.js site powered by Strapi, with AI editor integration.",
  icons: { icon: "/favicon.svg" },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
