import { useRef, useEffect, useCallback } from "react"

/**
 * Debounces a commit callback so rapid calls (e.g. keystrokes) batch into one.
 * `flushCommit()` fires the pending value immediately (useful on blur).
 */
export function useDebouncedCommit(onCommit: (value: string) => void, delay = 400) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<string | null>(null)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  const debouncedCommit = useCallback((value: string) => {
    pendingRef.current = value
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      pendingRef.current = null
      timerRef.current = null
      commitRef.current(value)
    }, delay)
  }, [delay])

  const flushCommit = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (pendingRef.current !== null) {
      const value = pendingRef.current
      pendingRef.current = null
      commitRef.current(value)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return { debouncedCommit, flushCommit }
}
