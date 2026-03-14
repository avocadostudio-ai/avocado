// ---------------------------------------------------------------------------
// Unified error hierarchy for the orchestrator
// ---------------------------------------------------------------------------

/**
 * Combined error category covering guardrails, planner failures, and
 * operational validation. Superset of the former `GuardrailErrorCategory`
 * and `PlannerFailureReasonCategory` types.
 */
export type ErrorCategory =
  | "schema_violation"
  | "ambiguity"
  | "not_found"
  | "no_effective_change"
  | "planner_refusal"
  | "incomplete_output"
  | "malformed_output"
  | "internal_error"
  | "canceled"
  | "operation_failed"

// Backward-compatible aliases
export type GuardrailErrorCategory = ErrorCategory
export type PlannerFailureReasonCategory = Extract<
  ErrorCategory,
  "schema_violation" | "planner_refusal" | "incomplete_output" | "malformed_output" | "internal_error"
>

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

/**
 * Base error for all orchestrator-layer failures.
 * Carries a machine-readable `category`, a flag indicating whether the
 * caller may retry, and a human-friendly `userMessage`.
 */
export class OrchestrationError extends Error {
  readonly category: ErrorCategory
  readonly retryable: boolean
  readonly userMessage: string

  constructor(
    message: string,
    options: {
      category: ErrorCategory
      retryable?: boolean
      userMessage?: string
    }
  ) {
    super(message)
    this.name = "OrchestrationError"
    this.category = options.category
    this.retryable = options.retryable ?? false
    this.userMessage = options.userMessage ?? message
  }
}

// ---------------------------------------------------------------------------
// Subclasses
// ---------------------------------------------------------------------------

/** Raised when the AI planner produces invalid / refused / incomplete output. */
export class PlannerError extends OrchestrationError {
  /** Alias kept for call-sites that read `.reasonCategory`. */
  get reasonCategory(): PlannerFailureReasonCategory {
    return this.category as PlannerFailureReasonCategory
  }

  constructor(
    message: string,
    options: {
      reasonCategory: PlannerFailureReasonCategory
      retryable?: boolean
      userMessage?: string
    }
  ) {
    super(message, {
      category: options.reasonCategory,
      retryable: options.retryable,
      userMessage: options.userMessage
    })
    this.name = "PlannerError"
  }
}

/** Raised when input fails a guardrail check before reaching the planner. */
export class GuardrailError extends OrchestrationError {
  constructor(
    message: string,
    options: {
      category: GuardrailErrorCategory
      retryable?: boolean
      userMessage?: string
    }
  ) {
    super(message, options)
    this.name = "GuardrailError"
  }
}

/** Raised when an operation (add_block, update_props, …) fails during apply. */
export class OperationError extends OrchestrationError {
  constructor(
    message: string,
    options?: {
      category?: ErrorCategory
      retryable?: boolean
      userMessage?: string
    }
  ) {
    super(message, {
      category: options?.category ?? "operation_failed",
      retryable: options?.retryable ?? false,
      userMessage: options?.userMessage
    })
    this.name = "OperationError"
  }
}

/** Raised when the user (or an abort signal) cancels an in-flight request. */
export class CancelError extends OrchestrationError {
  constructor(reason?: string) {
    super(reason ?? "user_canceled", {
      category: "canceled",
      retryable: false,
      userMessage: "Request was canceled."
    })
    this.name = "CancelError"
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isOrchestrationError(error: unknown): error is OrchestrationError {
  return error instanceof OrchestrationError
}

export function isPlannerError(error: unknown): error is PlannerError {
  return error instanceof PlannerError
}

/** @deprecated Use `isPlannerError` instead. Kept for backward compatibility. */
export function isPlannerOutputError(error: unknown): error is PlannerError {
  return isPlannerError(error)
}

export function isGuardrailError(error: unknown): error is GuardrailError {
  return error instanceof GuardrailError
}

export function isOperationError(error: unknown): error is OperationError {
  return error instanceof OperationError
}

export function isCancelError(error: unknown): error is CancelError {
  return error instanceof CancelError
}

// ---------------------------------------------------------------------------
// Unified toErrorDetail — single source of truth
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable error string from any thrown value.
 * Handles `Error`, Zod-like `{ issues }` objects, and plain strings.
 */
export function toErrorDetail(error: unknown): string {
  if (error instanceof OrchestrationError) return error.userMessage
  if (error instanceof Error) {
    // Try to extract a Zod-style message embedded in the error string
    const issueMatch = /"message"\s*:\s*"([^"]+)"/.exec(error.message)
    if (issueMatch?.[1]) return issueMatch[1]
    return error.message
  }
  if (
    error &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray((error as { issues?: unknown[] }).issues)
  ) {
    const first = (error as { issues: Array<{ message?: unknown; path?: unknown[] }> }).issues[0]
    if (first) {
      const msg = typeof first.message === "string" ? first.message : "Invalid model output"
      const path = Array.isArray(first.path) && first.path.length > 0 ? ` at ${first.path.join(".")}` : ""
      return `${msg}${path}`
    }
  }
  if (typeof error === "string") return error
  return "Unknown planner error"
}

// ---------------------------------------------------------------------------
// Backward-compatible aliases
// ---------------------------------------------------------------------------

/** @deprecated Use `PlannerError` directly. */
export const PlannerOutputError = PlannerError
