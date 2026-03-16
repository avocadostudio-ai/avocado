/**
 * Wire up carousel interactivity: prev/next buttons, dot navigation,
 * scroll-based active dot tracking, and optional autoplay.
 *
 * Safe to call multiple times — uses a data-ready guard to skip
 * already-initialized carousels.
 */
export function initCarousels(root: Document | HTMLElement = document) {
  root.querySelectorAll<HTMLElement>(".carousel:not([data-ready])").forEach((el) => {
    el.setAttribute("data-ready", "1")
    const track = el.querySelector<HTMLElement>(".carousel__track")
    if (!track) return

    const dots = el.querySelectorAll<HTMLElement>(".carousel__dot")
    const prev = el.querySelector<HTMLElement>(".carousel__btn--prev")
    const next = el.querySelector<HTMLElement>(".carousel__btn--next")

    const currentIndex = () => Math.round(track.scrollLeft / track.offsetWidth)
    const goTo = (i: number) => track.scrollTo({ left: i * track.offsetWidth, behavior: "smooth" })
    const syncDots = () => {
      const c = currentIndex()
      dots.forEach((d, i) => d.classList.toggle("carousel__dot--active", i === c))
    }

    if (prev) prev.onclick = () => { const i = currentIndex(); goTo(i > 0 ? i - 1 : dots.length - 1) }
    if (next) next.onclick = () => { const i = currentIndex(); goTo(i < dots.length - 1 ? i + 1 : 0) }
    dots.forEach((d, i) => { d.onclick = () => goTo(i) })
    track.addEventListener("scroll", syncDots, { passive: true })

    if (el.dataset.autoplay === "true") {
      const ms = parseInt(el.dataset.interval ?? "5000") || 5000
      const timer = setInterval(() => { const i = currentIndex(); goTo(i < dots.length - 1 ? i + 1 : 0) }, ms)
      el.addEventListener("pointerdown", () => clearInterval(timer), { once: true })
    }
  })
}
