import { test, expect, type Frame, type Page, type Locator } from "@playwright/test"

const EDITOR_URL = process.env.EDITOR_URL ?? "http://localhost:4100"

async function openEditorAndGetSiteFrame(page: Page): Promise<Frame> {
  await page.goto(EDITOR_URL + "/", { waitUntil: "networkidle", timeout: 30_000 })
  const iframeHandle = await page.waitForSelector("iframe[title]", { timeout: 20_000 })
  const frame = await iframeHandle.contentFrame()
  if (!frame) throw new Error("Editor iframe has no contentFrame")
  await frame.waitForLoadState("domcontentloaded")
  await frame.waitForSelector("[data-block-id]", { state: "attached", timeout: 20_000 })
  // Wait for the bridge to mount inside the iframe — it sets data-editor-active.
  await expect
    .poll(
      () => frame.evaluate(() => document.documentElement.hasAttribute("data-editor-active")),
      { timeout: 10_000 }
    )
    .toBe(true)
  return frame
}

async function ensureSelectionModeOn(page: Page, frame: Frame): Promise<void> {
  const already = await frame.evaluate(() =>
    document.documentElement.hasAttribute("data-editor-selection-mode")
  )
  if (already) return

  const visibleBtn = page.locator(".composer-selector-btn").filter({ visible: true } as never).first()
  // Fallback when filter({visible}) syntax isn't supported: walk all buttons.
  let clicker = visibleBtn
  if ((await clicker.count()) === 0) {
    const buttons = page.locator(".composer-selector-btn")
    const count = await buttons.count()
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i)
      if (await btn.isVisible()) {
        clicker = btn
        break
      }
    }
  }

  // Click the toggle, retrying up to 3 times in case the postMessage races the iframe load.
  for (let attempt = 0; attempt < 3; attempt++) {
    await clicker.click({ force: true })
    const ok = await frame
      .waitForFunction(
        () => document.documentElement.hasAttribute("data-editor-selection-mode"),
        null,
        { timeout: 3_000 }
      )
      .then(() => true)
      .catch(() => false)
    if (ok) return
  }
  throw new Error("Selection mode never armed in iframe after 3 toggle clicks")
}

function highlightedIds(frame: Frame): Promise<string[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll(".editor-highlight"))
      .map((el) => el.getAttribute("data-block-id") ?? "")
      .filter((id) => id.length > 0)
  )
}

// Click well inside the block, but bottom-center — far enough from the top-left
// floating toolbar (move/add/delete) that selection adds, so we hit the block
// background rather than a toolbar button.
async function clickBlockBackground(block: Locator): Promise<void> {
  const box = await block.boundingBox()
  if (!box) throw new Error("Block has no bounding box")
  await block.click({
    position: { x: Math.max(40, box.width / 2), y: Math.max(box.height - 24, 24) },
    force: true,
  })
}

test.describe("editor block selector", () => {
  test("first click selects, re-click toggles off, click-other switches selection", async ({ page }) => {
    const frame = await openEditorAndGetSiteFrame(page)
    await ensureSelectionModeOn(page, frame)

    const blocks = frame.locator("[data-block-id]")
    const blockCount = await blocks.count()
    expect(blockCount, "site needs at least 2 blocks for this regression test").toBeGreaterThanOrEqual(2)

    const firstBlock = blocks.nth(0)
    const firstId = await firstBlock.getAttribute("data-block-id")
    expect(firstId).toBeTruthy()

    // 1. First click → block becomes the only highlighted block.
    await clickBlockBackground(firstBlock)
    await expect.poll(() => highlightedIds(frame), { timeout: 5_000 }).toEqual([firstId])

    // 2. Re-click same block on non-editable area → toggle OFF (no highlights).
    //    Guards the regression where preview-adapter's deselect branch (d35f2b4)
    //    silently dropped out of the Next.js dev bundle due to .next caching.
    await clickBlockBackground(firstBlock)
    await expect.poll(() => highlightedIds(frame), { timeout: 5_000 }).toEqual([])

    // 3. Re-select, then click a different block → selection moves.
    await clickBlockBackground(firstBlock)
    await expect.poll(() => highlightedIds(frame), { timeout: 5_000 }).toEqual([firstId])

    const secondBlock = blocks.nth(1)
    const secondId = await secondBlock.getAttribute("data-block-id")
    expect(secondId).toBeTruthy()
    expect(secondId).not.toBe(firstId)

    await clickBlockBackground(secondBlock)
    await expect.poll(() => highlightedIds(frame), { timeout: 5_000 }).toEqual([secondId])
  })

  test("composer + property-panel selector buttons stay in sync and neither is disabled", async ({ page }) => {
    const frame = await openEditorAndGetSiteFrame(page)

    // Visit each tab so the property-panel button is mounted, then settle on
    // the Properties tab where the property-panel button is visible.
    const tabs = page.locator(".panel-tab-main")
    const tabCount = await tabs.count()
    expect(tabCount).toBeGreaterThan(0)

    // Heuristic: the Properties tab is the one with aria-label/title mentioning "Properties" in any locale.
    // Fall back to the second main tab (Chat is usually first, Properties second).
    const propertiesTab = tabs.nth(1)
    await propertiesTab.click()

    // Composer selector lives under .composer (visible on chat tab); property-panel
    // selector lives under .property-panel (visible on properties tab). Both are
    // always mounted — the parent's `display: none` is just visual.
    const composerBtn = page.locator(".composer .composer-selector-btn")
    const panelBtn = page.locator(".property-panel .property-panel-picker-btn")
    await expect(composerBtn).toHaveCount(1)
    await expect(panelBtn).toHaveCount(1)

    // Neither button should ever be `disabled` — both call the same toggle.
    // (Composer used to disable during isLoading; that asymmetry confused users
    // because the property-panel button kept working while the composer one
    // locked up.)
    expect(await composerBtn.isDisabled()).toBe(false)
    expect(await panelBtn.isDisabled()).toBe(false)

    // Toggling from the panel button should flip both buttons' aria-pressed.
    const initial = await composerBtn.getAttribute("aria-pressed")
    await panelBtn.click()
    await expect.poll(() => composerBtn.getAttribute("aria-pressed"), { timeout: 3_000 }).not.toBe(initial)
    await expect.poll(() => panelBtn.getAttribute("aria-pressed"), { timeout: 3_000 }).not.toBe(initial)
    // Both should agree with each other.
    expect(await composerBtn.getAttribute("aria-pressed")).toBe(await panelBtn.getAttribute("aria-pressed"))

    // Toggling back from the composer button should mirror to the panel button.
    // Switch to chat tab so the composer button is interactable.
    await tabs.nth(0).click()
    await composerBtn.click()
    await expect.poll(() => composerBtn.getAttribute("aria-pressed"), { timeout: 3_000 }).toBe(initial)
    await expect.poll(() => panelBtn.getAttribute("aria-pressed"), { timeout: 3_000 }).toBe(initial)
  })

  test("toggling the picker off preserves the block selection on both sides", async ({ page }) => {
    const frame = await openEditorAndGetSiteFrame(page)
    await ensureSelectionModeOn(page, frame)

    // Select a block.
    const firstBlock = frame.locator("[data-block-id]").first()
    const firstId = await firstBlock.getAttribute("data-block-id")
    await clickBlockBackground(firstBlock)
    await expect.poll(() => highlightedIds(frame), { timeout: 5_000 }).toEqual([firstId])

    // Toggle the picker OFF via the composer button.
    const composerBtn = page.locator(".composer .composer-selector-btn")
    await composerBtn.click()
    // Picker turned off in the iframe.
    await expect
      .poll(
        () => frame.evaluate(() => document.documentElement.hasAttribute("data-editor-selection-mode")),
        { timeout: 3_000 }
      )
      .toBe(false)

    // Selection should still be visible — picker-off must NOT clear the active block.
    await expect.poll(() => highlightedIds(frame), { timeout: 3_000 }).toEqual([firstId])

    // Re-arming the picker should still find the same block selected.
    await composerBtn.click()
    await expect
      .poll(
        () => frame.evaluate(() => document.documentElement.hasAttribute("data-editor-selection-mode")),
        { timeout: 3_000 }
      )
      .toBe(true)
    expect(await highlightedIds(frame)).toEqual([firstId])
  })

  test("clicking empty canvas with a block selected clears the selection", async ({ page }) => {
    const frame = await openEditorAndGetSiteFrame(page)
    await ensureSelectionModeOn(page, frame)

    const firstBlock = frame.locator("[data-block-id]").first()
    const firstId = await firstBlock.getAttribute("data-block-id")
    expect(firstId).toBeTruthy()

    await clickBlockBackground(firstBlock)
    await expect.poll(() => highlightedIds(frame), { timeout: 5_000 }).toEqual([firstId])

    // Click outside any [data-block-id] wrapper. We use a synthetic click on
    // <html> to deterministically hit "empty canvas" regardless of layout —
    // viewport-relative coordinate math is brittle when the iframe scrolls or
    // when block boxes fill the viewport.
    await frame.evaluate(() => {
      const evt = new MouseEvent("click", { bubbles: true, cancelable: true })
      document.documentElement.dispatchEvent(evt)
    })
    await expect.poll(() => highlightedIds(frame), { timeout: 5_000 }).toEqual([])
  })
})
