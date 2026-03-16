import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  transpilePackages: ["@ai-site-editor/preview-adapter", "@ai-site-editor/site-sdk", "@ai-site-editor/blocks"]
}

export default nextConfig
