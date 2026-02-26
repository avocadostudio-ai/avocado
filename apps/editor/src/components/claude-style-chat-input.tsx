import ArrowUpIcon from "./arrow-up-icon"

type ModelKey = "fast" | "balanced" | "reasoning" | "codex"

type Props = {
  message: string
  isLoading: boolean
  modelKey: ModelKey
  hasUserEntry: boolean
  onMessageChange: (value: string) => void
  onModelChange: (value: ModelKey) => void
  onSubmit: () => void
  onUndo: () => void
  onRedo: () => void
}

function modelLabel(model: ModelKey) {
  if (model === "fast") return "Fast"
  if (model === "reasoning") return "Reasoning"
  if (model === "codex") return "Codex"
  return "Balanced"
}

export default function ClaudeStyleChatInput(props: Props) {
  const { message, isLoading, modelKey, hasUserEntry, onMessageChange, onModelChange, onSubmit, onUndo, onRedo } = props

  return (
    <div className="composer-shell">
      <textarea
        value={message}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            onSubmit()
          }
        }}
        placeholder={hasUserEntry ? "" : "Try: Add testimonials below hero"}
        rows={1}
      />
      <div className="composer-actions">
        <div className="composer-actions-left">
          <button type="button" className="composer-ghost-btn" onClick={onUndo} disabled={isLoading} aria-label="Undo">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 7 4 12l5 5" />
              <path d="M5 12h7a4.5 4.5 0 0 1 0 9H10" />
            </svg>
          </button>
          <button type="button" className="composer-ghost-btn" onClick={onRedo} disabled={isLoading} aria-label="Redo">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m15 7 5 5-5 5" />
              <path d="M19 12h-7a4.5 4.5 0 0 0 0 9h2" />
            </svg>
          </button>
        </div>
        <div className="composer-actions-right">
          <label className="composer-model-picker">
            <span>{modelLabel(modelKey)}</span>
            <select value={modelKey} onChange={(e) => onModelChange(e.target.value as ModelKey)} aria-label="Select model">
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="reasoning">Reasoning</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <button type="button" className="composer-send-btn" onClick={onSubmit} disabled={isLoading || message.trim().length === 0} aria-label="Send message">
            <ArrowUpIcon size={16} color="currentColor" strokeWidth={2.8} />
          </button>
        </div>
      </div>
    </div>
  )
}
