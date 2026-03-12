import type { JsonSchema } from "./types.js"

export type SchemaValidationResult =
  | { ok: true }
  | { ok: false; message: string }

function typeMatches(schemaType: NonNullable<JsonSchema["type"]>, value: unknown) {
  if (schemaType === "string") return typeof value === "string"
  if (schemaType === "number") return typeof value === "number" && Number.isFinite(value)
  if (schemaType === "integer") return typeof value === "number" && Number.isInteger(value)
  if (schemaType === "boolean") return typeof value === "boolean"
  if (schemaType === "null") return value === null
  if (schemaType === "array") return Array.isArray(value)
  if (schemaType === "object") return value !== null && typeof value === "object" && !Array.isArray(value)
  return true
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "$"): SchemaValidationResult {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.some((entry) => Object.is(entry, value))) {
      return { ok: false, message: `${path}: value is not in enum` }
    }
  }

  if (schema.type && !typeMatches(schema.type, value)) {
    return { ok: false, message: `${path}: expected ${schema.type}` }
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) return { ok: false, message: `${path}: expected array` }
    if (schema.items) {
      for (let idx = 0; idx < value.length; idx += 1) {
        const result = validateAgainstSchema(value[idx], schema.items, `${path}[${idx}]`)
        if (!result.ok) return result
      }
    }
    return { ok: true }
  }

  if (schema.type === "object") {
    if (!isPlainObject(value)) return { ok: false, message: `${path}: expected object` }

    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (!(key in value)) return { ok: false, message: `${path}.${key}: required` }
    }

    const props = schema.properties ?? {}
    for (const [key, propSchema] of Object.entries(props)) {
      if (!(key in value)) continue
      const result = validateAgainstSchema(value[key], propSchema, `${path}.${key}`)
      if (!result.ok) return result
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) return { ok: false, message: `${path}.${key}: additional property is not allowed` }
      }
    }
  }

  return { ok: true }
}

export function validateToolManifestShape(manifest: {
  name?: unknown
  description?: unknown
  capability?: unknown
  timeoutMs?: unknown
  retryPolicy?: unknown
  idempotent?: unknown
  inputSchema?: unknown
  outputSchema?: unknown
}) {
  if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) return { ok: false as const, message: "manifest.name is required" }
  if (typeof manifest.description !== "string" || manifest.description.trim().length === 0) return { ok: false as const, message: "manifest.description is required" }
  if (manifest.capability !== "read" && manifest.capability !== "write") return { ok: false as const, message: "manifest.capability must be read or write" }
  if (typeof manifest.timeoutMs !== "number" || !Number.isFinite(manifest.timeoutMs) || manifest.timeoutMs < 250) return { ok: false as const, message: "manifest.timeoutMs must be >= 250" }
  if (!isPlainObject(manifest.retryPolicy)) return { ok: false as const, message: "manifest.retryPolicy is required" }
  if (typeof manifest.retryPolicy.maxAttempts !== "number" || !Number.isInteger(manifest.retryPolicy.maxAttempts) || manifest.retryPolicy.maxAttempts < 1 || manifest.retryPolicy.maxAttempts > 5) {
    return { ok: false as const, message: "manifest.retryPolicy.maxAttempts must be an integer between 1 and 5" }
  }
  if (typeof manifest.idempotent !== "boolean") return { ok: false as const, message: "manifest.idempotent must be boolean" }
  if (!isPlainObject(manifest.inputSchema)) return { ok: false as const, message: "manifest.inputSchema is required" }
  if (!isPlainObject(manifest.outputSchema)) return { ok: false as const, message: "manifest.outputSchema is required" }
  return { ok: true as const }
}
