import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: [
    "@ai-site-editor/blocks",
    "@ai-site-editor/preview-adapter",
    "@ai-site-editor/shared",
    "@ai-site-editor/site-sdk",
  ],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "plus.unsplash.com" },
      { protocol: "https", hostname: "oaidalleapiprodscus.blob.core.windows.net" },
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "http", hostname: "localhost" },
    ],
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = { ...config.watchOptions, followSymlinks: true }
      config.resolve = { ...config.resolve, symlinks: false }
    }
    return config
  },
}

export default nextConfig
