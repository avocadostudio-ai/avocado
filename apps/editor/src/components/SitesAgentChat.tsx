import { useEffect, useRef, useState } from "react"
import { useT } from "@/i18n"
import { renderSimpleMarkdown } from "../lib/markdown-renderer"
import { Bot, Trash2, Square, ArrowUp, Sparkles, ChevronDown, ChevronRight } from "lucide-react"
import type { UseSitesAgentReturn, SitesAgentMessage, PhaseStatus } from "../hooks/useSitesAgent"

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
              <button type="button" onClick={() => { setInput(t("sitesAgent.suggestion3")); textareaRef.current?.focus() }}>
                {t("sitesAgent.suggestion3")}
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

        {agent.isStreaming && agent.streamPhases.length > 0 && (
          <PhaseTracker phases={agent.streamPhases} />
        )}

        {agent.isStreaming && agent.streamSteps.length > 0 && (
          <StepTracker steps={agent.streamSteps} phaseLabels={agent.streamPhases.flatMap(p => [p.activeLabel, p.doneLabel])} />
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

function PhaseTracker({ phases }: { phases: PhaseStatus[] }) {
  return (
    <div className="sites-agent-phases">
      {phases.map((phase) => (
        <div key={phase.id} className={`sites-agent-phase ${phase.status}`}>
          <div className="sites-agent-phase-header">
            {phase.status === "done" ? (
              <svg viewBox="0 0 16 16" width="14" height="14"><path d="M13.5 4.5l-7 7L3 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            ) : (
              <span className="sites-agent-step-spinner" />
            )}
            <span className="sites-agent-phase-label">{phase.status === "done" ? phase.doneLabel : phase.activeLabel}</span>
          </div>
          {phase.outcome && (
            <div className="sites-agent-phase-outcome">{phase.outcome}</div>
          )}
        </div>
      ))}
    </div>
  )
}

function StepTracker({ steps, phaseLabels }: { steps: { label: string; done: boolean; count?: number }[]; phaseLabels: string[] }) {
  const [expanded, setExpanded] = useState(false)

  // Filter out steps that duplicate phase labels (e.g. "Analyzing website" shown in both)
  const phaseLower = phaseLabels.map(l => l.toLowerCase())
  const filtered = steps.filter(s => {
    const label = s.label.toLowerCase()
    return !phaseLower.some(p => label.startsWith(p) || p.startsWith(label))
  })

  const doneSteps = filtered.filter(s => s.done)
  const activeStep = filtered.find(s => !s.done)
  const doneCount = doneSteps.length

  return (
    <div className="sites-agent-steps">
      {doneCount > 0 && (
        <button
          type="button"
          className="sites-agent-steps-toggle"
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span>{expanded ? "Hide" : `${doneCount}`} step{doneCount > 1 ? "s" : ""}{expanded ? "" : " completed"}</span>
        </button>
      )}
      {expanded && doneSteps.map((step, i) => (
        <div key={`d${i}`} className="sites-agent-step done">
          <span className="sites-agent-step-dot-done" />
          <span>{step.label}{step.count && step.count > 1 ? ` (x${step.count})` : ""}</span>
        </div>
      ))}
      {activeStep && (
        <div className="sites-agent-step active">
          <span className="sites-agent-step-dot" />
          <span>{activeStep.label}</span>
        </div>
      )}
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
