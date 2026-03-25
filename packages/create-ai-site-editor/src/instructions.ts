import type { ScaffoldConfig } from "./types.js"
import { CMS_CONFIGS } from "./cms-config.js"

export function printInstructions(config: ScaffoldConfig): string {
  const c = CMS_CONFIGS[config.cms]
  const imagePatternLine = c.imageHostname
    ? `      { protocol: "https", hostname: "${c.imageHostname}" },\n`
    : ""

  return `
Manual steps:

1. next.config.ts — add:

${c.compilerConfig}  transpilePackages: [
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
${imagePatternLine}     ],
   },

2. globals.css — add at the top:

   @import "@ai-site-editor/blocks/styles.css";

3. Install dependencies:

   npm install @ai-site-editor/site-sdk @ai-site-editor/blocks @ai-site-editor/shared @ai-site-editor/preview-adapter${c.npmDeps}

4. Copy .env.local.example → .env.local and fill in your credentials

5. Start the orchestrator and editor (see docs/integration/README.md)
`
}
