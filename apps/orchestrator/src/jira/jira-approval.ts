/**
 * Approval keyword matcher for Jira comments.
 *
 * Used by the webhook dispatcher and poller to decide whether a reporter's
 * comment signals "go ahead" (in To Do → start editing, in In Review → publish).
 *
 * Kept deliberately small and keyword-based. LLM-based intent detection would
 * be overkill here — the set of things a reporter types to mean "yes" is small
 * and we want fast, deterministic routing.
 */

/**
 * Lowercase approval phrases. Matched as whole tokens (word boundaries) so
 * "confirmation" does not match "confirm" and "goodbye" does not match "go".
 */
export const APPROVAL_KEYWORDS: readonly string[] = [
  "proceed",
  "go",
  "go ahead",
  "yes",
  "ok",
  "okay",
  "approved",
  "approve",
  "lgtm",
  "ship it",
  "looks good",
  "confirm",
  "confirmed",
  "continue",
  "publish",
]

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Build once — case-insensitive, word-boundary on both sides, handles multi-word
// phrases by escaping the space too.
const APPROVAL_REGEX = new RegExp(
  `(?:^|\\W)(${APPROVAL_KEYWORDS.map(escapeRegex).join("|")})(?:$|\\W)`,
  "i"
)

/**
 * Return true when the comment text contains an approval keyword as a whole token.
 *
 * Only the first few hundred characters are scanned — reporters commonly lead
 * with "ok, also one more thing...", so longer prose doesn't need to match.
 */
export function isApprovalComment(text: unknown): boolean {
  if (typeof text !== "string") return false
  const trimmed = text.trim()
  if (!trimmed) return false
  return APPROVAL_REGEX.test(trimmed.slice(0, 500))
}
