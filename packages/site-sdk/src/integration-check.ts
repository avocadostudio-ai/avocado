import { getConfiguredDraftSecret } from "@avocadostudio-ai/shared"

let checked = false

/**
 * Run once on first editor API request to validate essential integration config.
 * Logs warnings to console — does not throw or block requests.
 */
export function checkIntegrationOnce() {
  if (checked) return
  checked = true

  const warnings: string[] = []

  // 1. Draft mode secret
  const draftSecret = getConfiguredDraftSecret(process.env as Record<string, string | undefined>)
  if (!draftSecret) {
    warnings.push(
      "DRAFT_MODE_SECRET is not set — editor draft mode will not work. " +
      "Set DRAFT_MODE_SECRET (or VITE_SITE_DRAFT_SECRET) in your .env file."
    )
  }

  // 2. Orchestrator URL
  const orchestratorUrl = process.env.ORCHESTRATOR_URL?.trim()
  if (!orchestratorUrl) {
    warnings.push(
      "ORCHESTRATOR_URL is not set — defaults to http://localhost:4200. " +
      "Set this in production to point to your deployed orchestrator."
    )
  }

  if (warnings.length > 0) {
    console.warn(
      "\n[ai-site-editor] Integration warnings:\n" +
      warnings.map((w) => `  ⚠ ${w}`).join("\n") +
      "\n"
    )
  }
}
