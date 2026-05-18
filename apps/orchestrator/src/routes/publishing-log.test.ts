import test from "node:test"
import assert from "node:assert/strict"
import { writeFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { app } from "../index.js"
import {
  registerPublishTarget,
  _resetPublishTargetsForTest,
} from "../publish/publish-target-registry.js"
import { SiteContractPublishTarget } from "../publish/targets/site-contract.js"
import { GitPublishTarget } from "../publish/targets/git.js"
import { DeployHookPublishTarget } from "../publish/targets/deploy-hook.js"
import type { PublishContext, PublishOutcome, PublishTarget } from "../publish/publish-target.js"
import { publishStatusBySession, listPublishLog } from "../state/session-state.js"

function createSessionId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`
}

/**
 * A controllable publish target. Tests assign to the static fields to drive
 * the next `publish()` call's outcome. `canHandle` always wins so this is
 * dispatched ahead of the built-in targets while installed.
 */
class StubPublishTarget implements PublishTarget {
  readonly name = "stub-test"
  static nextOutcome: PublishOutcome | null = null
  static lastCtx: PublishContext | null = null

  canHandle() {
    return true
  }

  async publish(ctx: PublishContext): Promise<PublishOutcome> {
    StubPublishTarget.lastCtx = ctx
    const outcome = StubPublishTarget.nextOutcome
    if (!outcome) throw new Error("StubPublishTarget: nextOutcome not configured for test")
    return outcome
  }
}

function installStubTarget() {
  _resetPublishTargetsForTest()
  registerPublishTarget(new StubPublishTarget())
}

function restoreBuiltinTargets() {
  _resetPublishTargetsForTest()
  registerPublishTarget(new SiteContractPublishTarget())
  registerPublishTarget(new GitPublishTarget())
  registerPublishTarget(new DeployHookPublishTarget())
}

async function seedDraftPage(session: string, siteId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/ops",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session,
      siteId,
      ops: [
        {
          op: "create_page",
          page: {
            id: "p_home",
            slug: "/",
            title: "Home",
            updatedAt: new Date().toISOString(),
            blocks: [],
          },
        },
      ],
    }),
  })
  assert.equal(res.statusCode, 200, `seed page failed: ${res.body}`)
}

test("publish/log: 400 when session is missing", async () => {
  const res = await app.inject({ method: "GET", url: "/publish/log" })
  assert.equal(res.statusCode, 400)
  const body = JSON.parse(res.body) as { error?: string }
  assert.equal(body.error, "session is required")
})

test("publish/log: empty list for a session with no publishes", async () => {
  const session = createSessionId("publish-log-empty")
  const res = await app.inject({
    method: "GET",
    url: `/publish/log?session=${encodeURIComponent(session)}&siteId=tenant-empty`,
  })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body) as { entries: unknown[] }
  assert.deepEqual(body.entries, [])
})

test("publish: success records a triggered publish-log entry", async () => {
  const session = createSessionId("publish-log-ok")
  const siteId = "tenant-pubok"

  installStubTarget()
  try {
    await seedDraftPage(session, siteId)

    StubPublishTarget.nextOutcome = {
      ok: true,
      httpStatus: 200,
      tracker: {
        session,
        status: "triggered",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        slugs: ["/"],
        deploymentId: "dpl_stub_1",
        deploymentUrl: "https://stub.vercel.app",
        inspectUrl: "https://vercel.com/inspect/dpl_stub_1",
        vercelState: "BUILDING",
      },
      response: { status: "ok", commitSha: "abc1234" },
    }

    const publishRes = await app.inject({
      method: "POST",
      url: "/publish",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, siteId }),
    })
    assert.equal(publishRes.statusCode, 200)

    const logRes = await app.inject({
      method: "GET",
      url: `/publish/log?session=${encodeURIComponent(session)}&siteId=${siteId}`,
    })
    assert.equal(logRes.statusCode, 200)
    const body = JSON.parse(logRes.body) as { entries: Array<Record<string, unknown>> }
    assert.equal(body.entries.length, 1)
    const entry = body.entries[0]
    assert.equal(entry.status, "triggered")
    assert.equal(entry.target, "stub-test")
    assert.equal(entry.siteId, siteId)
    assert.equal(entry.commit, "abc1234")
    assert.equal(entry.deploymentId, "dpl_stub_1")
    assert.equal(entry.deploymentUrl, "https://stub.vercel.app")
    assert.equal(entry.inspectUrl, "https://vercel.com/inspect/dpl_stub_1")
    assert.equal(entry.pageCount, 1)
    assert.deepEqual(entry.slugs, ["/"])
    assert.match(entry.summary as string, /Home/)
    assert.equal(typeof entry.id, "string")
    assert.equal(typeof entry.at, "string")
  } finally {
    restoreBuiltinTargets()
  }
})

test("publish: failure records a failed publish-log entry with error", async () => {
  const session = createSessionId("publish-log-fail")
  const siteId = "tenant-pubfail"

  installStubTarget()
  try {
    await seedDraftPage(session, siteId)

    StubPublishTarget.nextOutcome = {
      ok: false,
      httpStatus: 502,
      tracker: {
        session,
        status: "failed",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        slugs: ["/"],
        lastCheckError: "stub failure",
      },
      response: { error: "VERCEL_DEPLOY_HOOK_URL is not configured" },
    }

    const publishRes = await app.inject({
      method: "POST",
      url: "/publish",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, siteId }),
    })
    assert.equal(publishRes.statusCode, 502)

    const logRes = await app.inject({
      method: "GET",
      url: `/publish/log?session=${encodeURIComponent(session)}&siteId=${siteId}`,
    })
    const body = JSON.parse(logRes.body) as { entries: Array<Record<string, unknown>> }
    assert.equal(body.entries.length, 1)
    const entry = body.entries[0]
    assert.equal(entry.status, "failed")
    assert.equal(entry.error, "VERCEL_DEPLOY_HOOK_URL is not configured")
    assert.match(entry.summary as string, /VERCEL_DEPLOY_HOOK_URL/)
  } finally {
    restoreBuiltinTargets()
  }
})

test("publish/status: vercelState READY matures the publish-log row to success", async () => {
  const session = createSessionId("publish-log-mature")
  const siteId = "tenant-mature"
  const scopedSession = `${siteId}::${session}`

  installStubTarget()
  // Force the grace-period auto-resolve path to fire immediately so we do not
  // need a real Vercel token in the test environment.
  const prevToken = process.env.VERCEL_TOKEN
  const prevGrace = process.env.PUBLISH_GRACE_SECONDS
  delete process.env.VERCEL_TOKEN
  // Note: refreshPublishStatusFromVercel uses `Number(env) || 120`, so a
  // literal "0" falls back to 120. Use a tiny positive value paired with the
  // backdated startedAt below.
  process.env.PUBLISH_GRACE_SECONDS = "1"

  try {
    await seedDraftPage(session, siteId)

    StubPublishTarget.nextOutcome = {
      ok: true,
      httpStatus: 200,
      tracker: {
        session,
        status: "triggered",
        // Backdate so the grace check (elapsed >= 0) fires.
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        slugs: ["/"],
        // No deploymentId — exercises the "most recent triggered" fallback.
      },
      response: { status: "ok" },
    }

    const publishRes = await app.inject({
      method: "POST",
      url: "/publish",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, siteId }),
    })
    assert.equal(publishRes.statusCode, 200)

    // Confirm row landed as triggered.
    const initial = listPublishLog(scopedSession)
    assert.equal(initial.length, 1)
    assert.equal(initial[0].status, "triggered")

    // Poll /publish/status — grace path flips vercelState to READY → publish-log
    // row should mature to success.
    const statusRes = await app.inject({
      method: "GET",
      url: `/publish/status?session=${encodeURIComponent(session)}&siteId=${siteId}`,
    })
    assert.equal(statusRes.statusCode, 200)
    const statusBody = JSON.parse(statusRes.body) as { vercelState?: string }
    assert.equal(statusBody.vercelState, "READY")

    const after = listPublishLog(scopedSession)
    assert.equal(after.length, 1)
    assert.equal(after[0].status, "success")
    // updatedAt should be >= at (we don't assert strict inequality because
    // the maturation can happen inside the same millisecond as the insert).
    assert.ok(after[0].updatedAt >= after[0].at, "updatedAt must not regress")
  } finally {
    publishStatusBySession.delete(scopedSession)
    if (prevToken !== undefined) process.env.VERCEL_TOKEN = prevToken
    if (prevGrace !== undefined) process.env.PUBLISH_GRACE_SECONDS = prevGrace
    else delete process.env.PUBLISH_GRACE_SECONDS
    restoreBuiltinTargets()
  }
})

test("publish: synchronous target (vercelState=READY) records success immediately", async () => {
  const session = createSessionId("publish-log-sync")
  const siteId = "tenant-sync"
  const scopedSession = `${siteId}::${session}`

  installStubTarget()
  try {
    await seedDraftPage(session, siteId)

    // site-contract / git targets both set vercelState="READY" on success —
    // there is no pending Vercel build, so the row should be born as "success".
    StubPublishTarget.nextOutcome = {
      ok: true,
      httpStatus: 200,
      tracker: {
        session,
        status: "triggered",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        slugs: ["/"],
        vercelState: "READY",
      },
      response: { status: "ok" },
    }

    const publishRes = await app.inject({
      method: "POST",
      url: "/publish",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, siteId }),
    })
    assert.equal(publishRes.statusCode, 200)

    const log = listPublishLog(scopedSession)
    assert.equal(log.length, 1)
    assert.equal(log[0].status, "success", "synchronous READY target should land as success")
  } finally {
    restoreBuiltinTargets()
  }
})

test("publish: summary describes CHANGED pages, not all draft pages", async () => {
  const session = createSessionId("publish-log-diff")
  const siteId = "tenant-diff"

  // Stage a fake "published" snapshot containing the same Home page (so
  // re-publishing the same draft = no content changes). With this fixture
  // the diff engine sees draft and published as identical.
  const dir = await mkdtemp(join(tmpdir(), "publish-log-diff-"))
  const fixturePath = join(dir, "published.json")
  const homePage = {
    id: "p_home",
    slug: "/",
    title: "Home",
    updatedAt: new Date().toISOString(),
    blocks: [],
  }
  await writeFile(fixturePath, JSON.stringify({ pages: [homePage] }), "utf8")
  const prev = process.env.PUBLISHED_CONTENT_PATH
  process.env.PUBLISHED_CONTENT_PATH = fixturePath

  installStubTarget()
  try {
    await seedDraftPage(session, siteId)

    StubPublishTarget.nextOutcome = {
      ok: true,
      httpStatus: 200,
      tracker: {
        session,
        status: "triggered",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        slugs: ["/"],
        vercelState: "READY",
      },
      response: { status: "ok" },
    }

    const publishRes = await app.inject({
      method: "POST",
      url: "/publish",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, siteId }),
    })
    assert.equal(publishRes.statusCode, 200)

    const logRes = await app.inject({
      method: "GET",
      url: `/publish/log?session=${encodeURIComponent(session)}&siteId=${siteId}`,
    })
    const body = JSON.parse(logRes.body) as { entries: Array<Record<string, unknown>> }
    const entry = body.entries[0]
    // Draft == published → diff is empty → summary must NOT list pages.
    assert.match(entry.summary as string, /no content changes/i, `unexpected summary: ${entry.summary}`)
    assert.deepEqual(entry.diffSummary, { added: 0, removed: 0, changed: 0 })
    assert.equal(entry.pageCount, 1)
  } finally {
    if (prev !== undefined) process.env.PUBLISHED_CONTENT_PATH = prev
    else delete process.env.PUBLISHED_CONTENT_PATH
    restoreBuiltinTargets()
  }
})

test("publish/log: respects limit param (1-100 clamp)", async () => {
  const session = createSessionId("publish-log-limit")
  const siteId = "tenant-limit"

  installStubTarget()
  try {
    await seedDraftPage(session, siteId)

    StubPublishTarget.nextOutcome = {
      ok: true,
      httpStatus: 200,
      tracker: {
        session,
        status: "triggered",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        slugs: ["/"],
      },
      response: { status: "ok" },
    }

    // Three publishes.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/publish",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, siteId }),
      })
      assert.equal(res.statusCode, 200)
    }

    const lim1 = await app.inject({
      method: "GET",
      url: `/publish/log?session=${encodeURIComponent(session)}&siteId=${siteId}&limit=1`,
    })
    const body1 = JSON.parse(lim1.body) as { entries: unknown[] }
    assert.equal(body1.entries.length, 1)

    const limAll = await app.inject({
      method: "GET",
      url: `/publish/log?session=${encodeURIComponent(session)}&siteId=${siteId}&limit=50`,
    })
    const bodyAll = JSON.parse(limAll.body) as { entries: unknown[] }
    assert.equal(bodyAll.entries.length, 3)
  } finally {
    restoreBuiltinTargets()
  }
})
