/**
 * JIRA ticket processor.
 *
 * Extracts instructions + attachments from a JIRA issue, runs the agent loop
 * to edit the site, then posts results back to the ticket.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import type { FastifyBaseLogger } from "fastify"
import { JiraClient } from "./jira-client.js"
import type { JiraConfig, JiraIssue, JiraAttachment, JiraProcessingResult, JiraProcessingEntry, JiraUser } from "./jira-types.js"
import { createAgentTools, type AgentTool } from "../agent/agent-tools.js"
import { runAgentLoop } from "../agent/agent-loop.js"
import { buildAgentSystemPrompt, buildContextMessage } from "../agent/agent-context.js"
import type { AgentProvider } from "../agent/agent-provider.js"
import { resolveAgentModel } from "../agent/agent-provider.js"
import { scopedSessionKey, listSitesForSession, getSessionPages } from "../state/session-state.js"
import { pushJiraTelemetry, redactToolInput, type JiraTelemetryEntry, type JiraToolCallTrace } from "../telemetry/jira-telemetry.js"

// ---------------------------------------------------------------------------
// Processing mode
// ---------------------------------------------------------------------------

/**
 * Controls what processJiraTicket does:
 *  - "review":  agent reads the ticket without tools, posts a plan-or-questions
 *               comment, does not change the site, does not transition the issue.
 *  - "execute": agent runs with the full tool set, applies edits, transitions
 *               the issue to the preview status (or directly to done if
 *               autoPublish is enabled).
 *  - "publish": publish the session's draft, transition to done.
 */
export type JiraProcessingMode = "review" | "execute" | "publish"

// Agent-authored comments are identified by author accountId at the call site.
// The *kind* of agent comment (review questions, proceed, executed, published)
// is inferred from the distinctive bold headline each formatter emits — see
// `reviewCommentHeadlineRe` in countAgentReviewComments. HTML-comment markers
// were tried first but leak as literal text in ADF, so we rely on the
// human-readable headline instead.

// ---------------------------------------------------------------------------
// Processing queue (in-memory)
// ---------------------------------------------------------------------------

const processingQueue = new Map<string, JiraProcessingEntry>()
const recentResults: JiraProcessingResult[] = []
const MAX_RECENT = 50

export function getProcessingStatus() {
  return {
    queue: Array.from(processingQueue.values()),
    recent: recentResults.slice(0, 20),
  }
}

// ---------------------------------------------------------------------------
// Image + Document classification
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "svg", "gif"])
const TEXT_DOC_EXTENSIONS = new Set(["txt", "md"])
const PDF_EXTENSIONS = new Set(["pdf"])

function extensionOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? ""
}

function isImageAttachment(a: JiraAttachment): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(a.filename)) || a.mimeType.startsWith("image/")
}

function isTextDocAttachment(a: JiraAttachment): boolean {
  return TEXT_DOC_EXTENSIONS.has(extensionOf(a.filename)) || a.mimeType === "text/plain" || a.mimeType === "text/markdown"
}

function isPdfAttachment(a: JiraAttachment): boolean {
  return PDF_EXTENSIONS.has(extensionOf(a.filename)) || a.mimeType === "application/pdf"
}

// ---------------------------------------------------------------------------
// ADF → plain text converter
// ---------------------------------------------------------------------------

/**
 * Convert Atlassian Document Format to plain text.
 * Handles the common node types: paragraph, heading, text, hardBreak, listItem, codeBlock.
 */
export function adfToPlainText(node: unknown): string {
  if (!node || typeof node !== "object") return String(node ?? "")
  const obj = node as Record<string, unknown>

  // If it's a plain string (JIRA Server), return directly
  if (typeof node === "string") return node

  // Text node
  if (obj.type === "text" && typeof obj.text === "string") return obj.text

  // Hard break
  if (obj.type === "hardBreak") return "\n"

  // Recurse into content array
  const children = Array.isArray(obj.content)
    ? obj.content.map((child) => adfToPlainText(child)).join("")
    : ""

  // Add line breaks after block-level nodes
  switch (obj.type) {
    case "paragraph":
    case "heading":
    case "codeBlock":
    case "blockquote":
    case "rule":
      return children + "\n"
    case "listItem":
      return "- " + children + "\n"
    case "orderedList":
    case "bulletList":
    case "doc":
      return children
    default:
      return children
  }
}

// ---------------------------------------------------------------------------
// Attachment processing
// ---------------------------------------------------------------------------

type ProcessedAttachments = {
  imageReferences: string[] // URLs of saved images
  documentContext: string   // Extracted text from docs
  skipped: string[]         // Filenames that were skipped
}

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024 // 25MB

async function processAttachments(
  client: JiraClient,
  attachments: JiraAttachment[],
  generatedImageDir: string,
  orchestratorPublicOrigin: string,
  logger: FastifyBaseLogger
): Promise<ProcessedAttachments> {
  const imageReferences: string[] = []
  const docTexts: string[] = []
  const skipped: string[] = []

  for (const attachment of attachments) {
    if (attachment.size > MAX_ATTACHMENT_SIZE) {
      skipped.push(`${attachment.filename} (too large: ${Math.round(attachment.size / 1024 / 1024)}MB)`)
      continue
    }

    try {
      if (isImageAttachment(attachment)) {
        const buffer = await client.downloadAttachment(attachment.content)
        const ext = extensionOf(attachment.filename) || "png"
        // Use full UUID for collision-free filenames, avoiding Date.now() collision risk under concurrency
        const fileName = `jira_${randomUUID()}.${ext}`
        await mkdir(generatedImageDir, { recursive: true })
        await writeFile(resolve(generatedImageDir, fileName), buffer)
        const url = `${orchestratorPublicOrigin}/generated-images/${fileName}`
        imageReferences.push(`[Image: ${attachment.filename}](${url})`)
        logger.info({ filename: attachment.filename, saved: fileName }, "JIRA: saved image attachment")
      } else if (isTextDocAttachment(attachment)) {
        const buffer = await client.downloadAttachment(attachment.content)
        const text = buffer.toString("utf-8")
        docTexts.push(`--- Document: ${attachment.filename} ---\n${text.slice(0, 50_000)}\n--- End of ${attachment.filename} ---`)
        logger.info({ filename: attachment.filename, chars: text.length }, "JIRA: extracted text document")
      } else if (isPdfAttachment(attachment)) {
        // Basic PDF text extraction — try to read text content
        const buffer = await client.downloadAttachment(attachment.content)
        const text = extractBasicPdfText(buffer)
        if (text.trim()) {
          docTexts.push(`--- Document: ${attachment.filename} ---\n${text.slice(0, 50_000)}\n--- End of ${attachment.filename} ---`)
          logger.info({ filename: attachment.filename, chars: text.length }, "JIRA: extracted PDF text")
        } else {
          // PDF had no readable text content (empty or non-text PDF)
          skipped.push(`${attachment.filename} (PDF contains no extractable text)`)
        }
      } else {
        skipped.push(attachment.filename)
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      skipped.push(`${attachment.filename} (error: ${detail})`)
      logger.warn({ filename: attachment.filename, error: detail }, "JIRA: failed to process attachment")
    }
  }

  return {
    imageReferences,
    documentContext: docTexts.join("\n\n"),
    skipped,
  }
}

/**
 * Basic text extraction from PDF buffer.
 * Looks for text streams in the PDF structure — handles simple PDFs.
 * For complex PDFs, a dedicated library would be needed.
 * 
 * @throws {Error} If PDF appears invalid or critically malformed
 * @returns {string} Extracted text, or throws if extraction fails
 */
function extractBasicPdfText(buffer: Buffer): string {
  try {
    const raw = buffer.toString("latin1")
    
    // Validate buffer contains PDF markers
    if (!raw.includes("BT") || !raw.includes("ET")) {
      // No text operators found - this may be a valid PDF without text content,
      // but we explicitly return empty to distinguish from successful extraction
      return ""
    }
    
    const textParts: string[] = []

    // Extract text between BT (begin text) and ET (end text) operators
    const btEtRegex = /BT\s([\s\S]*?)ET/g
    let match: RegExpExecArray | null
    while ((match = btEtRegex.exec(raw)) !== null) {
      const block = match[1]
      // Extract text from Tj and TJ operators
      // Pattern: (text-content) Tj
      // Handles escaped parentheses by matching balanced pairs
      const tjRegex = /\(([^)]*(?:\\.[^)]*)*)\)\s*Tj/g
      let tm: RegExpExecArray | null
      while ((tm = tjRegex.exec(block)) !== null) {
        textParts.push(tm[1])
      }
      // TJ arrays: [(text) kern (text) ...]
      const tjArrayRegex = /\[([^\]]*)\]\s*TJ/g
      while ((tm = tjArrayRegex.exec(block)) !== null) {
        const inner = tm[1]
        // Match text strings with proper escape sequence handling
        const textInArray = /\(([^)]*(?:\\.[^)]*)*)\)/g
        let ti: RegExpExecArray | null
        while ((ti = textInArray.exec(inner)) !== null) {
          textParts.push(ti[1])
        }
      }
    }

    return textParts.join(" ").replace(/\\n/g, "\n").replace(/\s+/g, " ").trim()
  } catch (err) {
    // Re-throw with more context for debugging
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to extract text from PDF: ${detail}`)
  }
}

// ---------------------------------------------------------------------------
// Build instruction message from JIRA issue
// ---------------------------------------------------------------------------

function buildInstructionMessage(
  issue: JiraIssue,
  attachments: ProcessedAttachments,
  agentAccountId: string | undefined
): string {
  const parts: string[] = []

  // Summary as the primary instruction
  parts.push(`Task: ${issue.fields.summary}`)

  // Description as detailed instructions
  const description = typeof issue.fields.description === "string"
    ? issue.fields.description
    : adfToPlainText(issue.fields.description)
  if (description.trim()) {
    parts.push(`\nDetailed instructions:\n${description.trim()}`)
  }

  // Image references
  if (attachments.imageReferences.length > 0) {
    parts.push(`\nAttached images (use these for the site update):`)
    for (const ref of attachments.imageReferences) {
      parts.push(`  ${ref}`)
    }
  }

  // Document context
  if (attachments.documentContext) {
    parts.push(`\nReference documents (use this content as context for the site update):`)
    parts.push(attachments.documentContext)
  }

  // Skipped attachments
  if (attachments.skipped.length > 0) {
    parts.push(`\nNote: The following attachments could not be processed: ${attachments.skipped.join(", ")}`)
  }

  // Conversation history — so reporter clarifications posted as comments
  // reach the agent. Without this, a reply like "use this specific Unsplash
  // URL" is silently dropped and the agent falls back to its own guess.
  const history = buildCommentHistory(issue, agentAccountId)
  if (history) {
    parts.push(`\nConversation so far (oldest → newest). Treat the reporter's latest instructions as authoritative when they conflict with the description:\n${history}`)
  }

  return parts.join("\n")
}

/**
 * Render the ticket's comment thread as plain text labelled by role
 * (Agent / Reporter). Returns "" when there are no comments.
 *
 * Long bodies are truncated to keep token usage bounded — the reporter's
 * latest reply is what matters most, and we don't want old agent formatting
 * boilerplate to crowd out the real task context.
 */
export function buildCommentHistory(issue: JiraIssue, agentAccountId: string | undefined): string {
  const comments = issue.fields.comment?.comments ?? []
  if (comments.length === 0) return ""

  const MAX_BODY_CHARS = 1200
  const lines: string[] = []
  for (const c of comments) {
    const body = typeof c.body === "string" ? c.body : adfToPlainText(c.body)
    const trimmed = body.trim()
    if (!trimmed) continue
    const authorId = c.author?.accountId
    const isAgent = isAgentAuthoredComment(trimmed, authorId, agentAccountId)
    const role = isAgent ? "Agent" : "Reporter"
    const when = c.created ?? ""
    const truncated = trimmed.length > MAX_BODY_CHARS
      ? `${trimmed.slice(0, MAX_BODY_CHARS)}… [truncated]`
      : trimmed
    lines.push(`[${when}] ${role}:\n${truncated}`)
  }
  return lines.join("\n\n")
}

/**
 * Wrap each tool's handler so we record inputs, outputs, and durations into a
 * per-ticket trace. Also emits a structured pino line per call so tail -f on
 * the orchestrator's stdout reads well during live testing.
 *
 * The agent-loop `tool_done` event only exposes the result string, not the
 * input — so capturing input has to happen at handler-invocation time.
 */
function instrumentToolsForTrace(
  tools: AgentTool[],
  trace: JiraToolCallTrace[],
  logger: FastifyBaseLogger,
  issueKey: string
): AgentTool[] {
  return tools.map((t) => ({
    definition: t.definition,
    handler: async (input) => {
      const startedMs = Date.now()
      const result = await t.handler(input)
      const durationMs = Date.now() - startedMs
      const rawResult = typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? null)
      const resultExcerpt = rawResult.slice(0, 400)
      const isError = Boolean(result.isError)

      trace.push({
        name: t.definition.name,
        input: redactToolInput(input),
        durationMs,
        resultExcerpt,
        isError,
      })

      logger.info(
        {
          issueKey,
          tool: t.definition.name,
          durationMs,
          isError,
          inputKeys: Object.keys((input ?? {}) as Record<string, unknown>),
          resultExcerpt: resultExcerpt.slice(0, 180),
        },
        "JIRA: agent tool call"
      )

      return result
    },
  }))
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export async function processJiraTicket(options: {
  issueKey: string
  config: JiraConfig
  /** Which stage of the workflow to run. Defaults to "execute" for backward compat. */
  mode?: JiraProcessingMode
  generatedImageDir: string
  orchestratorPublicOrigin: string
  sitePublicOrigin: string
  logger: FastifyBaseLogger
  assignBackTo?: JiraUser
}): Promise<JiraProcessingResult> {
  const { issueKey, config, generatedImageDir, orchestratorPublicOrigin, sitePublicOrigin, logger, assignBackTo } = options
  const mode: JiraProcessingMode = options.mode ?? "execute"
  const startedAt = Date.now()

  // Track in queue
  const entry: JiraProcessingEntry = {
    issueKey,
    state: "processing",
    queuedAt: startedAt,
    startedAt,
  }
  processingQueue.set(issueKey, entry)

  // Telemetry scratchpad — assembled across branches so one entry is flushed
  // per ticket regardless of which mode we ran or where we exited.
  const telemetry: JiraTelemetryEntry = {
    timestamp: new Date(startedAt).toISOString(),
    issueKey,
    mode,
    siteId: "",
    session: "",
    status: "success",
    durationMs: 0,
    transitions: [],
  }

  const client = new JiraClient(config)

  try {
    // 1. Fetch issue
    logger.info({ issueKey }, "JIRA: fetching issue")
    const issue = await client.getIssue(issueKey)

    // 1b. Resolve which site the ticket targets. If ambiguous, post a
    // clarification comment listing available sites and stop.
    const resolved = resolveSiteForTicket(issue, config)
    if ("ambiguous" in resolved) {
      logger.info({ issueKey, candidates: resolved.candidates.map((c) => c.id) }, "JIRA: site ambiguous, asking for clarification")
      const comment = formatSiteClarificationComment(resolved.candidates)
      await client.addComment(issueKey, comment).catch((err) => {
        logger.warn({ issueKey, error: err instanceof Error ? err.message : String(err) }, "JIRA: failed to post clarification comment")
      })
      const result: JiraProcessingResult = {
        issueKey,
        status: "error",
        summary: "",
        changes: [],
        durationMs: Date.now() - startedAt,
        error: "ambiguous_site",
      }
      telemetry.status = "error"
      telemetry.error = "ambiguous_site"
      telemetry.durationMs = Date.now() - startedAt
      pushJiraTelemetry(telemetry)
      entry.state = "error"
      entry.completedAt = Date.now()
      entry.result = result
      recentResults.unshift(result)
      if (recentResults.length > MAX_RECENT) recentResults.pop()
      return result
    }
    const siteId = resolved.siteId
    logger.info({ issueKey, siteId, mode }, "JIRA: resolved site")

    // Share the session with the editor so Jira changes show up in the
    // editor view without per-ticket URLs. Concurrent tickets interleave.
    const sessionName = config.session
    const session = scopedSessionKey(sessionName, siteId)
    telemetry.siteId = siteId
    telemetry.session = session

    // -----------------------------------------------------------------------
    // Mode: PUBLISH — publish draft, transition to Done, post "Published" comment.
    // -----------------------------------------------------------------------
    if (mode === "publish") {
      const pagesBeforePublish = getSessionPages(session)
      const slugs = pagesBeforePublish.map((p) => p.slug).filter((s): s is string => typeof s === "string")

      try {
        await triggerPublish(session, siteId, logger)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        logger.error({ issueKey, error: errorMsg }, "JIRA: publish failed")
        const failureResult: JiraProcessingResult = {
          issueKey,
          status: "error",
          summary: "",
          changes: [],
          durationMs: Date.now() - startedAt,
          error: `publish_failed: ${errorMsg}`,
        }
        await client.addComment(issueKey, formatFailureComment(failureResult)).catch(() => {})
        telemetry.status = "error"
        telemetry.error = `publish_failed: ${errorMsg}`
        telemetry.durationMs = failureResult.durationMs
        telemetry.touchedSlugs = slugs
        pushJiraTelemetry(telemetry)
        return finalizeEntry(entry, failureResult)
      }

      const comment = formatPublishedComment({ sitePublicOrigin, slugs })
      await client.addComment(issueKey, comment).catch((err) => {
        logger.warn({ issueKey, error: err instanceof Error ? err.message : String(err) }, "JIRA: failed to post published comment")
      })

      if (config.doneStatus) {
        const transitioned = await client.transitionIssue(issueKey, config.doneStatus).catch(() => false)
        if (transitioned) {
          logger.info({ issueKey, status: config.doneStatus }, "JIRA: transitioned to done")
          telemetry.transitions?.push(config.doneStatus)
        }
      }

      const result: JiraProcessingResult = {
        issueKey,
        status: "success",
        summary: `Published ${slugs.length} page(s).`,
        changes: slugs,
        durationMs: Date.now() - startedAt,
        published: true,
      }
      telemetry.status = "success"
      telemetry.durationMs = result.durationMs
      telemetry.published = true
      telemetry.changes = slugs
      telemetry.touchedSlugs = slugs
      pushJiraTelemetry(telemetry)
      return finalizeEntry(entry, result)
    }

    // 2. Process attachments (review + execute both need these)
    const attachmentResult = await processAttachments(
      client,
      issue.fields.attachment ?? [],
      generatedImageDir,
      orchestratorPublicOrigin,
      logger
    )

    // 3. Build instruction message (includes comment history so reporter
    //    clarifications posted as comments reach the agent).
    const instruction = buildInstructionMessage(issue, attachmentResult, config.agentAccountId)
    logger.info({ issueKey, instructionLength: instruction.length }, "JIRA: built instruction")
    telemetry.instruction = instruction

    // 4. Determine AI provider and key from env
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) {
      throw new Error("No AI API key configured (need ANTHROPIC_API_KEY or OPENAI_API_KEY)")
    }
    const provider: AgentProvider = process.env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : "openai"
    const model = resolveAgentModel(provider)
    telemetry.provider = provider
    telemetry.model = model

    // -----------------------------------------------------------------------
    // Mode: REVIEW — dry-run planning pass, no tools, no transitions.
    // -----------------------------------------------------------------------
    if (mode === "review") {
      const priorReviews = countAgentReviewComments(issue, config.agentAccountId)
      if (priorReviews >= config.maxReviewPasses) {
        logger.info({ issueKey, priorReviews, cap: config.maxReviewPasses }, "JIRA: review pass cap reached")
        const comment = formatReviewCapComment(config.maxReviewPasses)
        await client.addComment(issueKey, comment).catch((err) => {
          logger.warn({ issueKey, error: err instanceof Error ? err.message : String(err) }, "JIRA: failed to post cap comment")
        })
        const capped: JiraProcessingResult = {
          issueKey,
          status: "success",
          summary: "review_cap_reached",
          changes: [],
          durationMs: Date.now() - startedAt,
          modelUsed: model,
        }
        return finalizeEntry(entry, capped)
      }

      const reviewPrompt = buildReviewSystemPrompt()
      const contextMsg = buildContextMessage(session, { slug: "/" })
      const userMessage = `${contextMsg}\n\n---\n\nTicket to review:\n${instruction}`

      logger.info({ issueKey, session, provider, model, priorReviews }, "JIRA: running review pass (no tools)")
      let rawOutput = ""
      for await (const event of runAgentLoop({
        apiKey,
        provider,
        model,
        systemPrompt: reviewPrompt,
        tools: [],
        userMessage,
      })) {
        if (event.type === "done") rawOutput = event.summary
        else if (event.type === "error") throw new Error(event.message)
      }

      const decision = parseReviewDecision(rawOutput)
      logger.info({ issueKey, decision: decision.decision, questions: decision.questions?.length ?? 0 }, "JIRA: review decision")

      const comment = formatReviewComment(decision)
      await client.addComment(issueKey, comment).catch((err) => {
        logger.warn({ issueKey, error: err instanceof Error ? err.message : String(err) }, "JIRA: failed to post review comment")
      })

      const reviewResult: JiraProcessingResult = {
        issueKey,
        status: "success",
        summary: decision.decision === "proceed" ? decision.plan.join("; ") : `questions: ${(decision.questions ?? []).length}`,
        changes: [],
        durationMs: Date.now() - startedAt,
        modelUsed: model,
      }
      telemetry.durationMs = reviewResult.durationMs
      telemetry.reviewDecision = decision
      telemetry.summary = reviewResult.summary
      pushJiraTelemetry(telemetry)
      return finalizeEntry(entry, reviewResult)
    }

    // -----------------------------------------------------------------------
    // Mode: EXECUTE — run agent with tools, apply edits, transition to preview
    // (or straight to done if autoPublish is on).
    // -----------------------------------------------------------------------
    const toolTrace: JiraToolCallTrace[] = []
    const tools = instrumentToolsForTrace(createAgentTools(session), toolTrace, logger, issueKey)
    const systemPrompt = buildAgentSystemPrompt()
    const contextMsg = buildContextMessage(session, { slug: "/" })
    const fullMessage = `${contextMsg}\n\n---\n\nUser request: ${instruction}`
    telemetry.toolCalls = toolTrace

    // Transition to executeStatus up-front so the board reflects reality
    // while the agent works.
    if (config.executeStatus) {
      await client.transitionIssue(issueKey, config.executeStatus)
        .then((ok) => { if (ok) telemetry.transitions?.push(config.executeStatus) })
        .catch((err) => {
          logger.warn({ issueKey, error: err instanceof Error ? err.message : String(err) }, "JIRA: failed to transition to execute status")
        })
    }

    // 6. Run agent loop
    logger.info({ issueKey, session, provider, model }, "JIRA: starting agent loop")
    const changes: string[] = []
    const touchedSlugs = new Set<string>()
    let summary = ""
    let toolCallCount = 0

    for await (const event of runAgentLoop({
      apiKey,
      provider,
      model,
      systemPrompt,
      tools,
      userMessage: fullMessage,
    })) {
      switch (event.type) {
        case "tool_done":
          if (!event.isError) {
            try {
              const parsed = JSON.parse(event.result)
              if (parsed.status === "applied") {
                const desc = parsed.changeDescription ?? parsed.summary
                if (typeof desc === "string" && desc.length > 0) {
                  changes.push(desc)
                }
                if (Array.isArray(parsed.slugs)) {
                  for (const s of parsed.slugs) {
                    if (typeof s === "string" && s.length > 0) touchedSlugs.add(s)
                  }
                }
              }
            } catch { /* read-only tool result */ }
          }
          break
        case "done":
          summary = cleanAgentSummary(event.summary)
          toolCallCount = event.toolCallCount
          break
        case "error":
          throw new Error(event.message)
      }
    }

    const durationMs = Date.now() - startedAt
    logger.info({ issueKey, changes: changes.length, durationMs }, "JIRA: agent completed")

    // 7. Auto-publish if enabled (legacy single-stage flow)
    let published = false
    if (config.autoPublish) {
      try {
        await triggerPublish(session, siteId, logger)
        published = true
        logger.info({ issueKey }, "JIRA: auto-published")
      } catch (err) {
        logger.warn({ issueKey, error: err instanceof Error ? err.message : String(err) }, "JIRA: auto-publish failed")
      }
    }

    // 8. Post completion comment
    const result: JiraProcessingResult = {
      issueKey,
      status: "success",
      summary,
      changes,
      durationMs,
      modelUsed: model,
      published,
    }

    const comment = formatSuccessComment(result, {
      orchestratorOrigin: orchestratorPublicOrigin,
      sitePublicOrigin,
      sessionName,
      siteId,
      touchedSlugs: Array.from(touchedSlugs),
      toolCallCount,
    })
    await client.addComment(issueKey, comment).catch((err) => {
      logger.warn({ issueKey, error: err instanceof Error ? err.message : String(err) }, "JIRA: failed to post success comment")
    })

    // 9. Assign ticket back to the requester
    if (assignBackTo && (assignBackTo.accountId || assignBackTo.name)) {
      await client.assignIssue(issueKey, {
        accountId: assignBackTo.accountId,
        name: assignBackTo.name,
      }).then(() => {
        logger.info({ issueKey, assignedTo: assignBackTo.displayName }, "JIRA: assigned back to requester")
      }).catch((err) => {
        logger.warn({ issueKey, error: err instanceof Error ? err.message : String(err) }, "JIRA: failed to assign back")
      })
    }

    // 10. Transition:
    //  - autoPublish=1: go straight to Done (published already).
    //  - otherwise: park in previewStatus so reporter can approve.
    const targetStatus = published ? config.doneStatus : (config.previewStatus || config.doneStatus)
    if (targetStatus) {
      const transitioned = await client.transitionIssue(issueKey, targetStatus).catch(() => false)
      if (transitioned) {
        logger.info({ issueKey, status: targetStatus }, "JIRA: transitioned issue")
        telemetry.transitions?.push(targetStatus)
      }
    }

    telemetry.status = "success"
    telemetry.durationMs = result.durationMs
    telemetry.summary = summary
    telemetry.changes = changes
    telemetry.touchedSlugs = Array.from(touchedSlugs)
    telemetry.toolCallCount = toolCallCount
    telemetry.published = published
    pushJiraTelemetry(telemetry)

    return finalizeEntry(entry, result)
  } catch (err) {
    const durationMs = Date.now() - startedAt
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error({ issueKey, error: errorMsg, durationMs }, "JIRA: processing failed")

    const result: JiraProcessingResult = {
      issueKey,
      status: "error",
      summary: "",
      changes: [],
      durationMs,
      error: errorMsg,
    }

    // Post failure comment
    const comment = formatFailureComment(result)
    await client.addComment(issueKey, comment).catch((commentErr) => {
      logger.warn({ issueKey, error: commentErr instanceof Error ? commentErr.message : String(commentErr) }, "JIRA: failed to post error comment")
    })

    // Transition to failed status
    if (config.failedStatus) {
      await client.transitionIssue(issueKey, config.failedStatus).catch(() => {})
    }

    telemetry.status = "error"
    telemetry.durationMs = durationMs
    telemetry.error = errorMsg
    pushJiraTelemetry(telemetry)

    return finalizeEntry(entry, result)
  } finally {
    // Clean up queue entry after a delay
    setTimeout(() => processingQueue.delete(issueKey), 60_000)
  }
}

// ---------------------------------------------------------------------------
// Publish trigger (internal)
// ---------------------------------------------------------------------------

async function triggerPublish(session: string, _siteId: string, logger: FastifyBaseLogger): Promise<void> {
  const { getSessionPages, setLastPublishedScopedSession } = await import("../state/session-state.js")
  const { publishViaGit } = await import("../publish/publish-helpers.js")

  const pages = getSessionPages(session)
  if (pages.length === 0) {
    logger.warn({ session }, "JIRA: no pages to publish")
    return
  }

  await publishViaGit(session)
  setLastPublishedScopedSession(session)
}

// ---------------------------------------------------------------------------
// Comment formatters
// ---------------------------------------------------------------------------

function formatSuccessComment(
  result: JiraProcessingResult,
  opts: {
    orchestratorOrigin: string
    sitePublicOrigin: string
    sessionName: string
    siteId: string
    touchedSlugs: string[]
    toolCallCount: number
  }
): string {
  void opts.orchestratorOrigin
  const { sitePublicOrigin, sessionName, siteId, touchedSlugs } = opts
  const lines: string[] = [
    "**Draft updated. Ready for your review.**",
    "",
  ]

  if (result.changes.length > 0) {
    lines.push("**Changes made:**")
    for (const change of result.changes) lines.push(`- ${change}`)
    lines.push("")
  }

  if (touchedSlugs.length > 0) {
    lines.push("**Preview:**")
    for (const slug of touchedSlugs) {
      const normalized = slug.startsWith("/") ? slug : `/${slug}`
      const pageLabel = normalized === "/" ? "Home" : normalized
      const url = `${sitePublicOrigin}${normalized}?session=${encodeURIComponent(sessionName)}&siteId=${encodeURIComponent(siteId)}&__editor=1`
      lines.push(`- [Open preview → ${pageLabel}](${url})`)
    }
    lines.push("")
  }

  if (result.summary) {
    lines.push(`**Summary:** ${result.summary}`)
    lines.push("")
  }

  lines.push(result.published
    ? "**Status:** Published to live site."
    : "**Next step:** Reply `approved` / `publish` / `lgtm` to publish, or send a follow-up instruction for more changes.")

  lines.push(`**AI Model:** ${result.modelUsed ?? "unknown"} | **Duration:** ${(result.durationMs / 1000).toFixed(1)}s | **Tool calls:** ${opts.toolCallCount}`)

  return lines.join("\n")
}

function formatFailureComment(result: JiraProcessingResult): string {
  const lines: string[] = [
    "**Website update failed for this ticket.**",
    "",
    `**Error:** ${result.error ?? "Unknown error"}`,
    "",
    "**Suggestion:** Please verify the instructions in the ticket description and retry, or check the orchestrator logs for details.",
  ]
  return lines.join("\n")
}

function formatSiteClarificationComment(candidates: Array<{ id: string; name?: string }>): string {
  const lines: string[] = [
    "**Which site should I update?**",
    "",
    "Multiple sites are configured and the ticket doesn't say which one to target. Please edit the ticket summary or description to include the site name or ID from this list, then re-trigger (change status again, or @mention me in a comment).",
    "",
    "**Available sites:**",
  ]
  for (const c of candidates) {
    const label = c.name ? `${c.name} (\`${c.id}\`)` : `\`${c.id}\``
    lines.push(`- ${label}`)
  }
  return lines.join("\n")
}

function formatReviewComment(decision: ReviewDecision): string {
  if (decision.decision === "questions") {
    const lines: string[] = [
      "**Review — I need a bit more info before I make changes.**",
      "",
    ]
    if (decision.plan.length > 0) {
      lines.push("**What I think you want:**")
      for (const item of decision.plan) lines.push(`- ${item}`)
      lines.push("")
    }
    lines.push("**Questions:**")
    const questions = decision.questions && decision.questions.length > 0
      ? decision.questions
      : ["Please clarify the request in a follow-up comment."]
    for (const q of questions) lines.push(`- ${q}`)
    lines.push("")
    lines.push("Reply with the answers and I'll re-review. Once everything's clear, reply `go` or move this ticket to In Progress and I'll apply the edits.")
    return lines.join("\n")
  }

  // proceed
  const lines: string[] = [
    "**Review complete — ready to proceed.**",
    "",
  ]
  if (decision.plan.length > 0) {
    lines.push("**Plan:**")
    for (const item of decision.plan) lines.push(`- ${item}`)
    lines.push("")
  }
  lines.push("Reply `go` (or `proceed`, `lgtm`, `approved`, etc.) or move the ticket to In Progress and I'll apply the edits.")
  return lines.join("\n")
}

function formatReviewCapComment(cap: number): string {
  return [
    "**I've asked for clarification several times.**",
    "",
    `Review attempts exhausted (max ${cap}). Please consolidate the request into a single, concrete instruction in the ticket description, then re-trigger by moving the ticket back to To Do or @mentioning me.`,
  ].join("\n")
}

function formatPublishedComment(opts: { sitePublicOrigin: string; slugs: string[] }): string {
  const lines: string[] = [
    "**Published. Changes are live.**",
    "",
  ]
  if (opts.slugs.length > 0) {
    lines.push("**Live pages:**")
    for (const slug of opts.slugs) {
      const normalized = slug.startsWith("/") ? slug : `/${slug}`
      const pageLabel = normalized === "/" ? "Home" : normalized
      const url = `${opts.sitePublicOrigin}${normalized === "/" ? "" : normalized}`
      lines.push(`- [Open live → ${pageLabel}](${url})`)
    }
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Review-mode helpers
// ---------------------------------------------------------------------------

export type ReviewDecision = {
  decision: "proceed" | "questions"
  plan: string[]
  questions?: string[]
}

/**
 * System prompt used for the review-only pass. The agent has no tools — it
 * reads the ticket + site context and returns a JSON verdict.
 */
function buildReviewSystemPrompt(): string {
  return [
    "You are reviewing a Jira ticket that requests changes to a website. You are in REVIEW MODE:",
    "- You have NO tools in this pass. Do not attempt to call any tools.",
    "- You will NOT be applying changes in this pass — a follow-up execution pass will do that after the reporter confirms.",
    "- Your job: decide whether the ticket has enough information to proceed safely, and if so, outline the plan.",
    "",
    "## What the execute pass CAN do",
    "You are not limited to what you can do here. The execute pass has the full editor toolset — don't claim capabilities are missing. In particular:",
    "- Edit any block's text, props, or items (Hero, CTA, FeatureGrid, FAQ, etc.), add / remove / reorder blocks, create / duplicate / delete pages.",
    "- Update site settings (name, logo, navigation labels, dropdown groups) and page SEO metadata.",
    "- **Search Unsplash for stock photos** (`unsplash_search`) and pick a match — so if the reporter asks for a \"tropical hero image\", you DO NOT need to ask them for a URL.",
    "- **Resolve Unsplash photo-page URLs** (`unsplash_get_by_id`) — if the reporter pastes `https://unsplash.com/photos/slug-PHOTOID`, the execute pass will resolve it to a direct image URL automatically. Do not ask for a \"direct image URL\" when a photo-page URL was given.",
    "- **Generate AI images** (`image_generate`) via DALL-E / Gemini when no stock photo fits or the reporter wants something specific.",
    "",
    "Only ask clarifying questions about genuinely ambiguous *content* (which page, which section, what copy, what link target, how many items). Never ask about a capability you actually have.",
    "",
    "Respond with ONLY a JSON object (no prose, no code fences, no markdown) in exactly this shape:",
    '{',
    '  "decision": "proceed" | "questions",',
    '  "plan": ["short bullet describing one concrete step", "…"],',
    '  "questions": ["short, specific question", "..."]',
    '}',
    "",
    "Rules:",
    '- Use "proceed" when the task is concrete enough to act on.',
    '- Use "questions" when something essential is missing or ambiguous (target page, copy, link targets, counts, etc.).',
    '- Always include "plan" — even with "questions" it should describe your best interpretation as an array of short bullets.',
    '- Each plan item is ONE concrete step (e.g. "Update b_hero_home heading to …"). Keep 2-5 items. No run-on sentences.',
    "- Keep questions to at most 3. Prefer clarity over completeness.",
    "- Do NOT ask about anything you can reasonably infer from the site context below.",
    "- Do NOT ask the reporter to provide an image URL just because a theme was requested — the execute pass will search Unsplash. Only ask about images when the request is genuinely ambiguous (e.g. \"use the brand mascot\" with no asset reference on file).",
  ].join("\n")
}

/**
 * Extract the review JSON from raw agent output. Tolerant of: leading/trailing
 * prose, ```json fences, and stray <thinking> tags.
 */
export function parseReviewDecision(raw: string): ReviewDecision {
  const cleaned = cleanAgentSummary(raw)
  const obj = tryParseJsonBlob(cleaned)
  if (obj && typeof obj === "object") {
    const rec = obj as Record<string, unknown>
    const decision = rec.decision === "questions" ? "questions" : "proceed"
    const plan = normalizePlanItems(rec.plan)
    const questions = Array.isArray(rec.questions)
      ? rec.questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      : []
    return decision === "questions"
      ? { decision, plan, questions }
      : { decision, plan }
  }
  // Couldn't parse — fall back to "proceed" with the raw text as the plan so the
  // reporter at least sees what the agent thought. Better than dropping info.
  const fallback = cleaned || "Could not parse review output — proceeding with best effort."
  return { decision: "proceed", plan: normalizePlanItems(fallback) }
}

/**
 * Normalize whatever the LLM returned for `plan` into an array of short bullet
 * strings. Accepts an array (preferred), a string (split on sentence/newline
 * boundaries for back-compat), or anything else (returns []).
 */
function normalizePlanItems(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (!trimmed) return []
    // Prefer newline splits, otherwise split on sentence boundaries (". ").
    const lineParts = trimmed.split(/\n+/).map((s) => s.trim()).filter(Boolean)
    const parts = lineParts.length > 1
      ? lineParts
      : trimmed.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((s) => s.trim()).filter(Boolean)
    return parts.map((s) => s.replace(/^[-*•]\s+/, "").trim()).filter(Boolean)
  }
  return []
}

function tryParseJsonBlob(text: string): unknown {
  if (!text) return null
  // Try direct parse first
  try { return JSON.parse(text) } catch { /* fall through */ }

  // Strip ```json ... ``` fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]) } catch { /* fall through */ }
  }

  // Greedy extract: first "{" to last "}"
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)) } catch { /* fall through */ }
  }
  return null
}

/**
 * Prefixes every agent-written comment begins with. We match on these rather
 * than `**…**` bold markup because Jira Cloud stores comments as ADF — when we
 * read them back, `adfToPlainText` strips the bold markers. The same prefix
 * check therefore works on both freshly-posted markdown and ADF-round-tripped
 * plain text.
 */
const AGENT_COMMENT_PREFIXES = {
  review: [
    "Review — I need",
    "Review complete — ready to proceed",
    "I've asked for clarification several times",
  ],
  other: [
    "Draft updated. Ready for your review",
    "Published. Changes are live",
    "Website update failed for this ticket",
    "Which site should I update",
  ],
} as const

const LEGACY_REVIEW_MARKER_RE = /<!--\s*site-editor:(?:review|proceed)\s*-->/
const LEGACY_AGENT_MARKER_RE = /<!--\s*site-editor:(?:review|proceed|executed|published)\s*-->/

function bodyStartsWithAny(body: string, prefixes: readonly string[]): boolean {
  // Strip leading whitespace and any lingering `**` bold markers so markdown
  // and ADF-plain-text bodies match the same prefix list.
  const stripped = body.replace(/^[\s*]+/, "")
  return prefixes.some((p) => stripped.startsWith(p))
}

/**
 * Count how many prior review-mode comments the agent has posted on this issue,
 * so we can cap the number of review passes per ticket.
 */
export function countAgentReviewComments(issue: JiraIssue, agentAccountId: string | undefined): number {
  const comments = issue.fields.comment?.comments ?? []
  let count = 0
  for (const c of comments) {
    if (agentAccountId && c.author?.accountId !== agentAccountId) continue
    const body = typeof c.body === "string" ? c.body : adfToPlainText(c.body)
    if (bodyStartsWithAny(body, AGENT_COMMENT_PREFIXES.review) || LEGACY_REVIEW_MARKER_RE.test(body)) count++
  }
  return count
}

/**
 * Decide whether a comment was authored by our agent.
 *
 * Looks at both the author's accountId AND the body shape. This matters because
 * in solo/dev Jira tenants the reporter and agent share a single human's
 * accountId — filtering by accountId alone would discard every reporter reply
 * as a self-loop and the workflow would stall.
 */
export function isAgentAuthoredComment(
  body: string,
  authorAccountId: string | undefined,
  agentAccountId: string | undefined
): boolean {
  if (!agentAccountId) return false
  if (authorAccountId !== agentAccountId) return false
  const allPrefixes = [...AGENT_COMMENT_PREFIXES.review, ...AGENT_COMMENT_PREFIXES.other]
  return bodyStartsWithAny(body, allPrefixes) || LEGACY_AGENT_MARKER_RE.test(body)
}

// ---------------------------------------------------------------------------
// Queue entry finalization — one place to update state for all mode outcomes
// ---------------------------------------------------------------------------

function finalizeEntry(entry: JiraProcessingEntry, result: JiraProcessingResult): JiraProcessingResult {
  entry.state = result.status === "success" ? "done" : "error"
  entry.completedAt = Date.now()
  entry.result = result
  recentResults.unshift(result)
  if (recentResults.length > MAX_RECENT) recentResults.pop()
  return result
}

// ---------------------------------------------------------------------------
// Summary cleanup + site resolver
// ---------------------------------------------------------------------------

/**
 * Strip internal reasoning artifacts from an agent summary before posting to Jira.
 * Claude occasionally emits <thinking>…</thinking> and similar XML-style reasoning
 * tags as plain text, plus interstitial tool-calling narration accumulates across
 * turns. Drop the noise, collapse whitespace.
 */
export function cleanAgentSummary(raw: string): string {
  if (!raw) return ""
  return raw
    // Strip paired thinking/scratchpad blocks with their contents
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<scratchpad\b[^>]*>[\s\S]*?<\/scratchpad>/gi, "")
    // Strip any leftover open/close tags (unpaired — e.g. truncated responses)
    .replace(/<\/?thinking\b[^>]*>/gi, "")
    .replace(/<\/?scratchpad\b[^>]*>/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Decide which site a ticket targets.
 *
 * 1. If the ticket text (summary + description) uniquely names a registered site,
 *    use it — this overrides defaults, so people can retarget without env changes.
 * 2. If `JIRA_SITE_ID` was explicitly set via env, trust it.
 * 3. If only one site is registered, use it.
 * 4. Otherwise: ambiguous — return the list so the caller can ask for clarification.
 */
export function resolveSiteForTicket(
  issue: JiraIssue,
  config: JiraConfig
): { siteId: string } | { ambiguous: true; candidates: Array<{ id: string; name?: string }> } {
  const registered = listSitesForSession(config.session)
  const summary = issue.fields.summary ?? ""
  const description = typeof issue.fields.description === "string"
    ? issue.fields.description
    : adfToPlainText(issue.fields.description)
  const text = `${summary}\n${description}`

  const matches = registered.filter((s) => {
    const idRe = new RegExp(`\\b${escapeRegex(s.id)}\\b`, "i")
    if (idRe.test(text)) return true
    if (s.name && s.name.trim()) {
      const nameRe = new RegExp(`\\b${escapeRegex(s.name)}\\b`, "i")
      if (nameRe.test(text)) return true
    }
    return false
  })
  if (matches.length === 1) return { siteId: matches[0].id }

  const envExplicit = typeof process.env.JIRA_SITE_ID === "string" && process.env.JIRA_SITE_ID.trim() !== ""
  if (envExplicit) return { siteId: config.siteId }

  if (registered.length <= 1) return { siteId: config.siteId }

  const candidates = matches.length > 1 ? matches : registered
  return { ambiguous: true, candidates: candidates.map((c) => ({ id: c.id, name: c.name })) }
}
