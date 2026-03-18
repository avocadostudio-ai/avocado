#!/usr/bin/env bash
set -euo pipefail

# Humanized 60s demo runner for the local editor using Playwright CLI.
# Default target: adventure-atlas

SITE_ID="${SITE_ID:-adventure-atlas}"
START_URL="${START_URL:-http://localhost:4100/?siteId=adventure-atlas}"
SESSION_NAME="${PLAYWRIGHT_CLI_SESSION:-demo-human-60s}"
DEMO_SLOWNESS="${DEMO_SLOWNESS:-1.6}"
DEMO_FULLSCREEN="${DEMO_FULLSCREEN:-1}"
# DEMO_FULLSCREEN modes:
#   0 = normal
#   1 = maximized window size (stable default)
#   2 = try browser fullscreen key toggles (less stable across environments)

export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="${PWCLI:-$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh}"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required. Install Node.js/npm first."
  exit 1
fi

if [[ ! -x "$PWCLI" ]]; then
  echo "Playwright wrapper not found or not executable: $PWCLI"
  exit 1
fi

echo "Starting humanized demo in session: $SESSION_NAME"
echo "Target site: $SITE_ID"
echo "Start URL: $START_URL"
echo "Slowness multiplier: $DEMO_SLOWNESS"
echo "Fullscreen mode: $DEMO_FULLSCREEN (0=off,1=max-window,2=key-toggle)"

"$PWCLI" -s="$SESSION_NAME" close >/dev/null 2>&1 || true
"$PWCLI" -s="$SESSION_NAME" open --headed
# Try to resize near full display size (macOS), fallback to a large viewport.
if command -v osascript >/dev/null 2>&1; then
  # Finder desktop window bounds: left, top, right, bottom
  BOUNDS="$(osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null || true)"
  if [[ "$BOUNDS" =~ ^([0-9]+),[[:space:]]*([0-9]+),[[:space:]]*([0-9]+),[[:space:]]*([0-9]+)$ ]]; then
    LEFT="${BASH_REMATCH[1]}"
    TOP="${BASH_REMATCH[2]}"
    RIGHT="${BASH_REMATCH[3]}"
    BOTTOM="${BASH_REMATCH[4]}"
    WIDTH=$(( RIGHT - LEFT - 10 ))
    HEIGHT=$(( BOTTOM - TOP - 40 ))
    if (( WIDTH > 1000 && HEIGHT > 700 )); then
      "$PWCLI" -s="$SESSION_NAME" resize "$WIDTH" "$HEIGHT"
    else
      "$PWCLI" -s="$SESSION_NAME" resize 1720 1040
    fi
  else
    "$PWCLI" -s="$SESSION_NAME" resize 1720 1040
  fi
else
  "$PWCLI" -s="$SESSION_NAME" resize 1720 1040
fi

TMP_JS="$(mktemp)"
cat >"$TMP_JS" <<'JS'
async (page) => {
const speed = __SLOWNESS__
const fullscreenMode = __FULLSCREEN__
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const scaled = (ms) => Math.max(0, Math.round(ms * speed))
const sleep = (min, max = min) => page.waitForTimeout(scaled(rand(min, max)))

async function humanMoveAndClick(locator) {
  const target = locator.first()
  await target.waitFor({ state: "visible", timeout: 30000 })
  const box = await target.boundingBox()
  if (!box) throw new Error("Could not resolve element bounding box for click")
  const x = box.x + box.width * (0.35 + Math.random() * 0.3)
  const y = box.y + box.height * (0.35 + Math.random() * 0.3)
  await page.mouse.move(x + rand(-40, 40), y + rand(-25, 25), { steps: rand(8, 18) })
  await sleep(60, 180)
  await page.mouse.move(x, y, { steps: rand(4, 10) })
  await sleep(70, 170)
  await page.mouse.down()
  await sleep(40, 110)
  await page.mouse.up()
}

async function assistantCount() {
  return await page.locator(".msg.msg-assistant").count()
}

async function maybeApprovePlan() {
  const approve = page.getByRole("button", { name: /Approve plan/i }).first()
  if (await approve.isVisible().catch(() => false)) {
    await sleep(200, 500)
    await humanMoveAndClick(approve)
    await sleep(200, 400)
    return true
  }
  return false
}

async function waitForAssistantProgress(previousCount) {
  await page.waitForFunction(
    (prev) => document.querySelectorAll(".msg.msg-assistant").length > prev,
    previousCount,
    { timeout: 90000 }
  )

  // If request is long-running, wait for "Stop generation" to disappear.
  const stopBtn = page.getByRole("button", { name: /Stop generation/i }).first()
  if (await stopBtn.isVisible().catch(() => false)) {
    await stopBtn.waitFor({ state: "hidden", timeout: 90000 }).catch(() => {})
  }
}

async function typeHuman(textarea, text) {
  await humanMoveAndClick(textarea)
  await page.keyboard.press("ControlOrMeta+A")
  await page.keyboard.press("Backspace")
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: scaled(rand(24, 84)) })
    if (Math.random() < 0.07) await sleep(40, 140)
  }
}

async function sendPrompt(prompt) {
  const before = await assistantCount()
  const textarea = page.getByPlaceholder("Tell me what to change").first()
  await typeHuman(textarea, prompt)
  await sleep(120, 260)
  await page.keyboard.press("Enter")
  await waitForAssistantProgress(before)

  // Handle optional plan approval flow, then wait for final assistant application message.
  const approved = await maybeApprovePlan()
  if (approved) {
    const afterApproveBaseline = await assistantCount()
    await waitForAssistantProgress(afterApproveBaseline - 1)
  }
  await sleep(250, 500)
}

async function selectRoute(slug) {
  const select = page.locator(".chat-header-slug select").first()
  await select.waitFor({ state: "visible", timeout: 30000 })
  await humanMoveAndClick(select)
  await sleep(100, 220)
  await select.selectOption(slug)
  await sleep(260, 560)
}

async function selectFirstNonHomeRouteAndBack() {
  const select = page.locator(".chat-header-slug select").first()
  await select.waitFor({ state: "visible", timeout: 30000 })
  const values = await select.locator("option").evaluateAll((opts) =>
    opts
      .map((opt) => opt.value)
      .filter((v) => typeof v === "string" && v.length > 0)
  )
  const target = values.find((v) => v !== "/")
  if (target) {
    await selectRoute(target)
  }
  await selectRoute("/")
}

const startUrl = "__START_URL__"

await page.goto(startUrl, { waitUntil: "domcontentloaded" })
await sleep(500, 900)

if (fullscreenMode === 2) {
  // Optional true fullscreen hotkeys (can be flaky on some systems).
  try {
    await page.mouse.click(20, 20)
    await sleep(100, 200)
    await page.keyboard.press("F11")
  } catch {}
  try {
    await sleep(150, 300)
    await page.keyboard.press("Meta+Control+f")
  } catch {}
  await sleep(400, 700)
}

await page.waitForSelector(".chat-header-slug select", { timeout: 30000 })
await sleep(400, 800)

// 2) Route switch proof (dynamic: first non-home route -> home).
await selectFirstNonHomeRouteAndBack()

// 3) Human-like typed edit request.
await sendPrompt("Rewrite home hero headline and subheading for an education-first avocado brand, in a modern confident tone.")

// 4) Turn on selection mode, click a block in preview, generate/apply variations.
const selectElementBtn = page.getByRole("button", { name: /Select an element|Exit selector mode/i }).first()
await humanMoveAndClick(selectElementBtn)
await sleep(220, 420)

const liveFrame = page.frameLocator('iframe[title="Live preview"]')
const firstEditable = liveFrame.locator("[data-editable-target]").first()
await firstEditable.waitFor({ state: "visible", timeout: 30000 })
await firstEditable.click({ delay: rand(40, 120) })
await sleep(250, 450)

await sendPrompt("Generate 3 variations for this block")

const variationModal = page.locator(".variation-modal").first()
if (await variationModal.isVisible().catch(() => false)) {
  const firstCard = variationModal.locator(".variation-card").first()
  await humanMoveAndClick(firstCard)
  await sleep(160, 320)
  await humanMoveAndClick(variationModal.locator(".variation-apply-btn").first())
  await sleep(500, 900)
}

// 5) Undo once.
const undoBtn = page.locator(".msg-undo-btn:visible").first()
if (await undoBtn.isVisible().catch(() => false)) {
  await humanMoveAndClick(undoBtn)
  await sleep(500, 900)
}

// 6) Publish and open live link if shown.
const publishBtn = page.getByRole("button", { name: /^Publish$/ }).first()
await humanMoveAndClick(publishBtn)
await sleep(1200, 2200)

const liveLink = page.locator(".live-site-icon-btn").first()
if (await liveLink.isVisible().catch(() => false)) {
  await humanMoveAndClick(liveLink)
  await sleep(500, 900)
}

await page.screenshot({ path: "output/playwright/demo-60s-humanized-final.png", fullPage: true })
}
JS
RUN_CODE="$(cat "$TMP_JS")"
rm -f "$TMP_JS"
ESCAPED_START_URL="${START_URL//\\/\\\\}"
ESCAPED_START_URL="${ESCAPED_START_URL//\"/\\\"}"
RUN_CODE="${RUN_CODE//__START_URL__/$ESCAPED_START_URL}"
RUN_CODE="${RUN_CODE//__SLOWNESS__/$DEMO_SLOWNESS}"
RUN_CODE="${RUN_CODE//__FULLSCREEN__/$DEMO_FULLSCREEN}"
"$PWCLI" -s="$SESSION_NAME" run-code "$RUN_CODE"

echo "Done. Screenshot: output/playwright/demo-60s-humanized-final.png"
echo "If browser is still open, close with:"
echo "  $PWCLI -s=$SESSION_NAME close"
