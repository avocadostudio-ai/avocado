/**
 * Persistent agent logger — appends NDJSON to .data/agent-log.ndjson.
 * Complements console.log (stdout) so agent timing data survives restarts.
 */

import { appendFileSync } from "node:fs"
import { resolve } from "node:path"

const LOG_PATH = resolve(process.cwd(), "../../.data/agent-log.ndjson")

export function logAgent(streamId: string, event: string, detail?: Record<string, unknown>, startedAt?: number): void {
  const entry = {
    ts: Date.now(),
    elapsed: startedAt ? +((Date.now() - startedAt) / 1000).toFixed(1) : undefined,
    stream: streamId.slice(0, 8),
    event,
    ...detail,
  }
  try {
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n")
  } catch {
    // silently ignore — logging should never break the agent
  }
}
