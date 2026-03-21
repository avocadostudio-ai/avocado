import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "export",
  transpilePackages: [
    "@ai-site-editor/blocks",
  ],
  images: {
    unoptimized: true,
  },
}

export default nextConfig
