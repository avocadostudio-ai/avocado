import { useEffect, useRef, useState } from "react"
import { useT } from "@/i18n"
import { renderSimpleMarkdown } from "../lib/markdown-renderer"
import { Bot, Trash2, Square, ArrowUp, Sparkles } from "lucide-react"
import type { UseSitesAgentReturn, SitesAgentMessage } from "../hooks/useSitesAgent"

type Props = {
  agent: UseSitesAgentReturn
}

export function SitesAgentChat({ agent }: Props) {
  const { t } = useT()
  const [input, setInput] = useState("")
  const threadRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll on new messages or streaming text
  useEffect(() => {
    const el = threadRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [agent.messages, agent.streamingText, agent.streamStatus])

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = "0px"
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
  }, [input])

  function handleSubmit() {
    if (!input.trim() || agent.isStreaming) return
    agent.sendMessage(input)
    setInput("")
  }

  const showWelcome = agent.messages.length === 0 && !agent.isStreaming

  return (
    <aside className="sites-agent-panel">
      <header className="sites-agent-header">
        <div className="sites-agent-header-left">
          <Bot size={18} />
          <span>{t("sitesAgent.title")}</span>
        </div>
        {agent.messages.length > 0 && (
          <button
            type="button"
            className="sites-agent-clear-btn"
            onClick={agent.clearMessages}
            title={t("sitesAgent.clear")}
          >
            <Trash2 size={14} />
          </button>
        )}
      </header>

      <div className="sites-agent-thread" ref={threadRef}>
        {showWelcome && (
          <div className="sites-agent-welcome">
            <div className="sites-agent-welcome-icon">
              <Sparkles size={32} />
            </div>
            <p className="sites-agent-welcome-text">{t("sitesAgent.welcome")}</p>
            <div className="sites-agent-suggestions">
              <button type="button" onClick={() => { setInput(t("sitesAgent.suggestion1")); textareaRef.current?.focus() }}>
                {t("sitesAgent.suggestion1")}
              </button>
              <button type="button" onClick={() => { setInput(t("sitesAgent.suggestion2")); textareaRef.current?.focus() }}>
                {t("sitesAgent.suggestion2")}
              </button>
            </div>
          </div>
        )}

        {agent.messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {agent.streamingText && (
          <div className="sites-agent-message sites-agent-message-assistant">
            <div className="sites-agent-message-content">{renderSimpleMarkdown(agent.streamingText)}</div>
          </div>
        )}

        {agent.isStreaming && agent.streamSteps.length > 0 && (
          <StepTracker steps={agent.streamSteps} />
        )}
      </div>

      {agent.messages.length > 0 && !agent.isStreaming && (
        <button
          type="button"
          className="sites-agent-fab-clear"
          onClick={agent.clearMessages}
          title={t("sitesAgent.clear")}
        >
          <Trash2 size={14} />
        </button>
      )}

      <div className="sites-agent-composer">
        <div className="sites-agent-input-wrap">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                handleSubmit()
              }
            }}
            placeholder={t("sitesAgent.placeholder")}
            rows={1}
            disabled={agent.isStreaming}
          />
          {agent.isStreaming ? (
            <button type="button" className="sites-agent-stop-btn" onClick={agent.cancelStream} title={t("sitesAgent.stop")}>
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="sites-agent-send-btn"
              onClick={handleSubmit}
              disabled={!input.trim()}
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}

const MAX_VISIBLE_STEPS = 6

function StepTracker({ steps }: { steps: { label: string; done: boolean; count?: number }[] }) {
  // Filter out duplicate consecutive done steps (already collapsed via count)
  // and skip steps with count > 1 that are done (show only the collapsed version)
  const visibleSteps = steps.filter(s => !(s.done && (s.count ?? 1) > 1))
  const hiddenCount = steps.length - visibleSteps.length
  const capped = visibleSteps.length > MAX_VISIBLE_STEPS
    ? visibleSteps.slice(visibleSteps.length - MAX_VISIBLE_STEPS)
    : visibleSteps
  const extraHidden = hiddenCount + (visibleSteps.length - capped.length)

  return (
    <div className="sites-agent-steps">
      {extraHidden > 0 && (
        <div className="sites-agent-step done" style={{ opacity: 0.5, fontSize: 11 }}>
          <svg viewBox="0 0 16 16" width="10" height="10"><path d="M13.5 4.5l-7 7L3 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span>{extraHidden} earlier step{extraHidden > 1 ? "s" : ""} completed</span>
        </div>
      )}
      {capped.map((step, i) => (
        <div key={i} className={`sites-agent-step ${step.done ? "done" : "active"}`}>
          {step.done ? (
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="M13.5 4.5l-7 7L3 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          ) : (
            <span className="sites-agent-step-spinner" />
          )}
          <span>{step.label}{step.count && step.count > 1 ? ` (x${step.count})` : ""}</span>
        </div>
      ))}
    </div>
  )
}

function MessageBubble({ message }: { message: SitesAgentMessage }) {
  const isUser = message.role === "user"
  return (
    <div className={`sites-agent-message ${isUser ? "sites-agent-message-user" : "sites-agent-message-assistant"}`}>
      <div className="sites-agent-message-content">{renderSimpleMarkdown(message.text)}</div>
    </div>
  )
}
