import { useState } from "react"
import { useT } from "../i18n"

export type ThinkingBlockProps = {
  text: string
  status: "streaming" | "done"
  durationMs?: number
  /** Collapsed by default. Callers can force-open for debugging. */
  defaultOpen?: boolean
}

export function ThinkingBlock({ text, status, durationMs, defaultOpen = false }: ThinkingBlockProps) {
  const { t } = useT()
  const [open, setOpen] = useState(defaultOpen)
  const hasContent = text.length > 0
  const isStreaming = status === "streaming"

  const label = isStreaming
    ? t("chat.thinking.streaming")
    : typeof durationMs === "number" && durationMs > 0
      ? t("chat.thinking.doneSeconds", { seconds: String(Math.max(1, Math.round(durationMs / 1000))) })
      : t("chat.thinking.done")

  const toggle = () => {
    if (!hasContent) return
    setOpen((v) => !v)
  }

  return (
    <div className={`thinking-block${isStreaming ? " thinking-block--streaming" : " thinking-block--done"}${open ? " thinking-block--open" : ""}`}>
      <button
        type="button"
        className="thinking-block-header"
        onClick={toggle}
        disabled={!hasContent}
        aria-expanded={open}
        aria-label={open ? t("chat.thinking.showLess") : t("chat.thinking.showMore")}
      >
        <span className="thinking-block-chevron" aria-hidden="true">
          {open ? "v" : ">"}
        </span>
        <span className="thinking-block-label">{label}</span>
        {isStreaming ? (
          <span className="thinking-block-indicator" aria-hidden="true">
            <span className="thinking-block-dot" />
            <span className="thinking-block-dot" />
            <span className="thinking-block-dot" />
          </span>
        ) : (
          <span className="thinking-block-check" aria-hidden="true">✓</span>
        )}
      </button>
      {open && hasContent ? (
        <div className="thinking-block-body">
          <pre className="thinking-block-text">{text}</pre>
        </div>
      ) : null}
    </div>
  )
}
