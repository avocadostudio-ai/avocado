import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-site-editor/preview-adapter", "@ai-site-editor/site-sdk", "@ai-site-editor/blocks", "@ai-site-editor/immersive-widget"],
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
      // Watch workspace packages through symlinks for HMR
      config.watchOptions = {
        ...config.watchOptions,
        followSymlinks: true,
        poll: 1000,
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/.next/**',
          '**/dist/**',
          '**/build/**',
          '**/coverage/**',
          '**/apps/editor/**',
          '**/apps/orchestrator/**',
          '**/examples/**',
        ],
      }
      // Resolve workspace symlinks to their real paths so webpack tracks them
      config.resolve = {
        ...config.resolve,
        symlinks: false,
      }
      // Bust persistent cache for workspace packages so HMR picks up changes
      // without needing to manually delete .next/cache.
      // Uses BUILD_ID env (set by dev script) or timestamp as cache version.
      config.cache = {
        ...config.cache,
        version: `${process.env.WORKSPACE_CACHE_BUST ?? Date.now()}`,
      }
    }
    return config
  },
}

export default nextConfig
