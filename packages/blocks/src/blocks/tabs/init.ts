/**
 * Wire up tab switching, and overflow fade gradient for the tab bar.
 * Safe to call multiple times — uses a data-ready guard.
 */
export function initTabs(root: Document | HTMLElement = document) {
  root.querySelectorAll<HTMLElement>(".tabs-block:not([data-ready])").forEach((el) => {
    el.setAttribute("data-ready", "1")
    const tabButtons = el.querySelectorAll<HTMLElement>(".tabs-block__tab")
    const panels = el.querySelectorAll<HTMLElement>(".tabs-block__panel")
    const barWrap = el.querySelector<HTMLElement>(".tabs-block__bar-wrap")
    const bar = el.querySelector<HTMLElement>(".tabs-block__bar")

    // Tab switching
    tabButtons.forEach((btn, i) => {
      btn.onclick = () => {
        tabButtons.forEach((b, j) => {
          b.classList.toggle("tabs-block__tab--active", i === j)
          b.setAttribute("aria-selected", i === j ? "true" : "false")
        })
        panels.forEach((p, j) => {
          p.style.display = i === j ? "" : "none"
        })
      }
    })

    // Overflow fade gradient
    if (barWrap && bar) {
      const syncOverflow = () => {
        const overflows = bar.scrollWidth > bar.clientWidth
        barWrap.classList.toggle("tabs-block__bar-wrap--overflow", overflows)
        const atEnd = bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 2
        barWrap.classList.toggle("tabs-block__bar-wrap--at-end", atEnd)
      }
      syncOverflow()
      bar.addEventListener("scroll", syncOverflow, { passive: true })
      // Re-check on resize (e.g. viewport toggle in catalogue)
      new ResizeObserver(syncOverflow).observe(bar)
    }
  })
}
