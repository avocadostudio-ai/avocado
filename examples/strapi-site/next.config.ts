import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: [
    "@ai-site-editor/blocks",
    "@ai-site-editor/preview-adapter",
    "@ai-site-editor/site-sdk",
  ],
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost" },
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "plus.unsplash.com" },
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "https", hostname: "via.placeholder.com" },
      { protocol: "https", hostname: "**.blob.core.windows.net" },
    ],
  },
}

export default nextConfig
