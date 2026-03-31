import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: [
    "@ai-site-editor/preview-adapter",
    "@ai-site-editor/site-sdk",
    "@ai-site-editor/blocks",
    "@ai-site-editor/shared",
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
      config.cache = { ...config.cache, version: `${process.env.WORKSPACE_CACHE_BUST ?? Date.now()}` }
    }
    return config
  },
}

export default nextConfig
