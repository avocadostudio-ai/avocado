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

  // If the field is empty, lead with a "write" suggestion
  if (!currentValue.trim()) {
    pills.push(`Write a ${fieldLabel.toLowerCase()} for this ${blockType}`)
  }

  const lower = fieldLabel.toLowerCase()
  const isCta = lower.includes("cta") || lower.includes("button") || lower.includes("link text")
  const isHeading = lower.includes("heading") || lower.includes("title") || lower.includes("headline")

  if (kind === "imageAlt") {
    pills.push("Generate alt text", "Improve accessibility", "Make more descriptive")
  } else if (kind === "richtext") {
    pills.push("Improve writing", "Make it more concise", "Simplify language", "Expand with more detail")
  } else if (isCta) {
    pills.push("Make CTA more persuasive", "Shorten CTA", "Add urgency", "Suggest 3 alternatives")
  } else if (isHeading) {
    pills.push("Improve headline", "Shorten headline", "Suggest 3 alternatives", "Make it more engaging")
  } else {
    // Generic text field
    pills.push("Improve this text", "Make it shorter", "Make it more engaging", "Suggest 3 alternatives")
  }

  return pills
}
