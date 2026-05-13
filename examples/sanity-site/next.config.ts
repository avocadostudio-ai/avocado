import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  compiler: {
    styledComponents: true,
  },
  transpilePackages: [
    "@avocadostudio-ai/blocks",
    "@ai-site-editor/preview-adapter",
    "@avocadostudio-ai/shared",
    "@ai-site-editor/site-sdk",
  ],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.sanity.io" },
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "plus.unsplash.com" },
      { protocol: "https", hostname: "oaidalleapiprodscus.blob.core.windows.net" },
      { protocol: "https", hostname: "placehold.co" },
      { protocol: "http", hostname: "localhost" },
    ],
  },
  webpack: (config, { dev }) => {
    if (dev) {
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
          '**/apps/**',
          '**/examples/strapi-site/**',
          '**/examples/contentful-site/**',
          '**/examples/sample-site/**',
        ],
      }
      config.resolve = { ...config.resolve, symlinks: false }
    }
    return config
  },
}

export default nextConfig
