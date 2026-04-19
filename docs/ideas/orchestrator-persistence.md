# Orchestrator Persistence

**Status:** Deferred — address before horizontal scaling or multi-instance deployment.

## Problem

All orchestrator state lives in-memory (`apps/orchestrator/src/state/session-state.ts`) with a debounced 80ms write to `.data/orchestrator-state.json` plus rolling backups. Consequences:

- Crash loses unpublished drafts (whatever hasn't flushed yet)
- Can't run multiple orchestrator instances (no shared state)
- Flat-file doesn't scale and isn't ACID

## Options

### 1. Harden flat-file (lowest effort)

Sync write-on-every-op instead of debounced, plus atomic rename (`write tmp → rename`) to prevent partial writes on crash. Still single-process, but the crash-loss window shrinks to near-zero. No new dependencies.

### 2. SQLite via `better-sqlite3` (recommended next step)

Embedded, zero infra. The synchronous `better-sqlite3` API fits the current synchronous state accessors without a refactor. Sessions become rows; ops are appended as a log table; state is rebuilt on startup from the log. Works naturally with Render's persistent disk.

### 3. Redis

Session state maps naturally to hashes/sorted sets. Built-in TTL handles ephemeral demo sessions. Pub/sub is ready if live collab is ever added. Needs a Redis instance (Render add-on or Upstash). Medium effort, adds an external dependency.

### 4. Postgres / Neon

Full relational, horizontally scalable. Evaluated previously — parked because it adds ops complexity for a single-tenant deployment. Revisit when multi-instance orchestrator is needed.

## Recommendation

Start with **SQLite**. It eliminates the crash-loss risk with no new infrastructure, the synchronous API avoids refactoring the current state accessors, and the Render disk is already persistent.
