import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const PAST_TENSE: Record<string, string> = {
  Installing: "Installed", Reading: "Read", Writing: "Wrote", Editing: "Edited",
  Searching: "Searched", Downloading: "Downloaded", Building: "Built", Creating: "Created",
  Analyzing: "Analyzed", Scaffolding: "Scaffolded", Discovering: "Discovered",
  Extracting: "Extracted", Applying: "Applied", Cloning: "Cloned", Verifying: "Verified",
  Clearing: "Cleared", Running: "Ran", Checking: "Checked", Delegating: "Delegated",
  Registering: "Registered",
}

/** Convert "Installing dependencies" → "Installed dependencies" for done steps. */
export function toPastTense(label: string): string {
  const match = label.match(/^(\S+?)(\s.*)$/)
  if (!match) return label
  const [, verb, rest] = match
  if (PAST_TENSE[verb]) return PAST_TENSE[verb] + rest
  if (verb.endsWith("ing")) return verb.slice(0, -3) + "ed" + rest
  return label
}
