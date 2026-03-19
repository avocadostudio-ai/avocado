import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-site-editor/preview-adapter", "@ai-site-editor/site-sdk", "@ai-site-editor/blocks"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "plus.unsplash.com" },
      { protocol: "https", hostname: "oaidalleapiprodscus.blob.core.windows.net" },
      { protocol: "https", hostname: "**.blob.core.windows.net" },
      { protocol: "http", hostname: "localhost" },
    ],
  },
  webpack: (config) => {
    // Watch workspace packages through symlinks for HMR
    config.watchOptions = {
      ...config.watchOptions,
      followSymlinks: true,
    }
    // Resolve workspace symlinks to their real paths so webpack tracks them
    config.resolve = {
      ...config.resolve,
      symlinks: false,
    }
    return config
  },
}

export default nextConfig
