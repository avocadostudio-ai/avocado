export function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  }
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  }
}
