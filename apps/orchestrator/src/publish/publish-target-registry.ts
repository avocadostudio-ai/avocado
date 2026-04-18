import type { PublishContext, PublishTarget } from "./publish-target.js"
import { SiteContractPublishTarget } from "./targets/site-contract.js"
import { GitPublishTarget } from "./targets/git.js"
import { DeployHookPublishTarget } from "./targets/deploy-hook.js"

/**
 * Registry for {@link PublishTarget} plugins.
 *
 * Built-in targets (`site-contract`, `git`, `deploy-hook`) are registered at
 * module load. Downstream code — whether a consumer of this project or a
 * future plugin — can register additional targets before the server starts
 * handling requests:
 *
 * ```ts
 * import { registerPublishTarget } from "./publish/publish-target-registry.js"
 * registerPublishTarget(new S3PublishTarget())
 * ```
 *
 * Target selection order on every `POST /publish` call:
 *  1. If `PUBLISH_TARGET=<name>` env var is set AND that target is registered,
 *     use it verbatim. (Escape hatch for operators who want to force one.)
 *  2. Otherwise, iterate registered targets and pick the first whose
 *     `canHandle(ctx)` returns true.
 *  3. Fall back to `PUBLISH_MODE` (legacy env): `git` (default) or
 *     `deploy_hook` → `deploy-hook`.
 */

const targets = new Map<string, PublishTarget>()

export function registerPublishTarget(target: PublishTarget): void {
  targets.set(target.name, target)
}

export function getPublishTarget(name: string): PublishTarget | undefined {
  return targets.get(name)
}

export function listPublishTargets(): PublishTarget[] {
  return Array.from(targets.values())
}

/** Primarily for tests; leaves the registry empty. */
export function _resetPublishTargetsForTest(): void {
  targets.clear()
}

export function selectPublishTarget(ctx: PublishContext): PublishTarget | undefined {
  const override = process.env.PUBLISH_TARGET?.trim()
  if (override) {
    const forced = targets.get(override)
    if (forced) return forced
  }

  for (const target of targets.values()) {
    if (target.canHandle?.(ctx)) return target
  }

  const legacyMode = (process.env.PUBLISH_MODE?.trim().toLowerCase() || "git") as string
  if (legacyMode === "deploy_hook") return targets.get("deploy-hook")
  return targets.get("git")
}

// Register built-ins on module load. Order matters: `canHandle` is checked
// in insertion order, so site-contract (which has a real `canHandle`) must
// come first — the others have no `canHandle` and are only reachable via the
// explicit/legacy fallback path.
registerPublishTarget(new SiteContractPublishTarget())
registerPublishTarget(new GitPublishTarget())
registerPublishTarget(new DeployHookPublishTarget())
