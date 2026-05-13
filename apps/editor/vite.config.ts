import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "next/image": path.resolve(__dirname, "src/stubs/next-image.tsx"),
    },
  },
  server: {
    watch: {
      // Follow symlinks into workspace packages so HMR detects changes
      ignored: ["!**/node_modules/@ai-site-editor/**"],
    },
  },
  optimizeDeps: {
    // Don't pre-bundle workspace packages — allow live HMR from source
    exclude: ["@avocadostudio-ai/shared", "@avocadostudio-ai/blocks"],
  },
})
