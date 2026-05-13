import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-site-editor/preview-adapter", "@ai-site-editor/site-sdk", "@avocadostudio-ai/blocks", "@ai-site-editor/immersive-widget"],
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
      // Cache version for workspace packages. Stable by default so Next.js
      // reuses .next/cache across restarts — skipping ~15s of cold compile.
      // Set WORKSPACE_CACHE_BUST to any new value (e.g. $(date +%s)) to force
      // a rebuild when a workspace package change isn't picked up by HMR.
      config.cache = {
        ...config.cache,
        version: `${process.env.WORKSPACE_CACHE_BUST ?? "stable-v1"}`,
      }
    }
    return config
  },
}

export default nextConfig
