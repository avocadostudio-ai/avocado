import { registerCustomRenderer } from "@ai-site-editor/blocks"
import "./pricing-table/schema.ts"
import { PricingTable } from "./pricing-table/renderer.tsx"

registerCustomRenderer("PricingTable", PricingTable)
