// ---------------------------------------------------------------------------
// Lightweight per-session async mutex using promise chains.
// Serializes applyOpsAtomically() calls within a session to prevent
// concurrent read-modify-write races (e.g. multi-tab, fast typing).
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>()

/**
 * Acquire an exclusive lock for `session`. The returned release function
 * MUST be called when done — wrap the critical section in try/finally.
 *
 * Usage:
 *   const release = await acquireSessionLock(session)
 *   try { … } finally { release() }
 */
export function acquireSessionLock(session: string): Promise<() => void> {
  const prev = locks.get(session) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.set(session, next)
  return prev.then(() => release)
}

/**
 * Remove stale lock entries (e.g. on session cleanup).
 */
export function clearSessionLock(session: string) {
  locks.delete(session)
}
