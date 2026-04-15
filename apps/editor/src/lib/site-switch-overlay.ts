// Pure DOM (no React) so it paints in the same tick as `location.href = ...`,
// closing the window where users double-click thinking the switch didn't register.
export function showSiteSwitchOverlay(siteName: string, prefix: string): void {
  if (typeof document === "undefined") return
  if (document.getElementById("site-switch-overlay")) return

  const overlay = document.createElement("div")
  overlay.id = "site-switch-overlay"
  overlay.setAttribute("role", "status")
  overlay.setAttribute("aria-live", "polite")
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "flex-direction:column",
    "gap:14px",
    "background:rgba(15,17,21,0.78)",
    "backdrop-filter:blur(6px)",
    "color:#f5f5f7",
    "font:500 14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "letter-spacing:0.01em",
    "cursor:wait",
  ].join(";")

  const spinner = document.createElement("div")
  spinner.style.cssText = [
    "width:28px",
    "height:28px",
    "border:2px solid rgba(255,255,255,0.18)",
    "border-top-color:#fff",
    "border-radius:50%",
    "animation:site-switch-spin 0.8s linear infinite",
  ].join(";")

  const label = document.createElement("div")
  label.textContent = `${prefix} ${siteName}…`

  if (!document.getElementById("site-switch-overlay-style")) {
    const style = document.createElement("style")
    style.id = "site-switch-overlay-style"
    style.textContent = "@keyframes site-switch-spin{to{transform:rotate(360deg)}}"
    document.head.appendChild(style)
  }

  overlay.appendChild(spinner)
  overlay.appendChild(label)
  document.body.appendChild(overlay)
}
