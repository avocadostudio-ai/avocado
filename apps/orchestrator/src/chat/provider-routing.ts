import type { AIProvider, ModelKey } from "../state/session-state.js"

export type PlannerSource = "openai" | "anthropic" | "gemini" | "demo"

export function resolveEffectiveProvider(args: {
  requestedProvider?: AIProvider
  availableProviders: AIProvider[]
  fallbackProvider: AIProvider
}): AIProvider {
  if (args.requestedProvider && args.availableProviders.includes(args.requestedProvider)) {
    return args.requestedProvider
  }
  return args.fallbackProvider
}

export function resolveModelKeyForProvider(args: {
  requestedModelKey?: ModelKey
  provider: AIProvider
  modelLookup: Record<AIProvider, Record<ModelKey, string>>
  defaultModelKey?: ModelKey
}): ModelKey {
  if (args.requestedModelKey && args.modelLookup[args.provider][args.requestedModelKey]) {
    return args.requestedModelKey
  }
  return args.defaultModelKey ?? "balanced"
}

export function resolvePlannerSource(provider: AIProvider): PlannerSource {
  return provider === "gemini" && process.env.GOOGLE_GENAI_API_KEY
    ? "gemini"
    : provider === "anthropic" && process.env.ANTHROPIC_API_KEY
      ? "anthropic"
      : provider === "openai" && process.env.OPENAI_API_KEY
        ? "openai"
        : process.env.OPENAI_API_KEY
          ? "openai"
          : process.env.ANTHROPIC_API_KEY
            ? "anthropic"
            : process.env.GOOGLE_GENAI_API_KEY
              ? "gemini"
              : "demo"
}
