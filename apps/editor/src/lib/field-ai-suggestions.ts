/**
 * Returns the top 2-3 quick actions for the dropdown (subset of full suggestions).
 */
export function fieldAiQuickActions(
  kind: string,
  fieldLabel: string,
  blockType: string,
  currentValue: string
): string[] {
  const full = fieldAiSuggestions(kind, fieldLabel, blockType, currentValue)
  return full.slice(0, 2)
}

/**
 * Returns contextual AI suggestion pills based on field kind and current value.
 */
export function fieldAiSuggestions(
  kind: string,
  fieldLabel: string,
  blockType: string,
  currentValue: string
): string[] {
  const pills: string[] = []
  const lower = fieldLabel.toLowerCase()

  // If the field is empty, lead with a "write" suggestion
  if (!currentValue.trim()) {
    pills.push(`Write a ${lower} for this ${blockType}`)
  }

  const isSeoTitle = lower.includes("seo") && lower.includes("title")
  const isMetaDesc = lower.includes("meta") && lower.includes("description")
  const isSeo = isSeoTitle || isMetaDesc
  const isCta = lower.includes("cta") || lower.includes("button") || lower.includes("link text")
  const isHeading = !isSeo && (lower.includes("heading") || lower.includes("title") || lower.includes("headline"))

  if (kind === "imageAlt") {
    pills.push("Generate alt text", "Improve accessibility", "Make more descriptive")
  } else if (isSeoTitle) {
    pills.push("Optimize for search ranking", "Fit within 60 characters", "Add primary keyword", "Suggest 3 alternatives")
  } else if (isMetaDesc) {
    pills.push("Optimize for click-through rate", "Fit within 160 characters", "Add a call to action", "Suggest 3 alternatives")
  } else if (kind === "richtext") {
    pills.push(`Tighten ${lower}`, "Simplify language", "Expand with more detail", "Suggest 3 alternatives")
  } else if (isCta) {
    pills.push(`Make ${lower} more persuasive`, `Shorten ${lower}`, "Add urgency", "Suggest 3 alternatives")
  } else if (isHeading) {
    pills.push(`Punch up ${lower}`, `Shorten ${lower}`, "Suggest 3 alternatives", `Make ${lower} more engaging`)
  } else {
    // Generic text field
    pills.push(`Rephrase ${lower}`, "Make it shorter", "Make it more engaging", "Suggest 3 alternatives")
  }

  return pills
}
