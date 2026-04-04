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
import { createAgentTools } from "../agent/agent-tools.js"
import { runAgentLoop } from "../agent/agent-loop.js"
import { buildAgentSystemPrompt, buildContextMessage } from "../agent/agent-context.js"
import type { AgentProvider } from "../agent/agent-provider.js"
import { resolveAgentModel } from "../agent/agent-provider.js"
import { scopedSessionKey } from "../state/session-state.js"

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
        const fileName = `jira_${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`
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
  attachments: ProcessedAttachments
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

  return parts.join("\n")
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export async function processJiraTicket(options: {
  issueKey: string
  config: JiraConfig
  generatedImageDir: string
  orchestratorPublicOrigin: string
  logger: FastifyBaseLogger
  assignBackTo?: JiraUser
}): Promise<JiraProcessingResult> {
  const { issueKey, config, generatedImageDir, orchestratorPublicOrigin, logger, assignBackTo } = options
  const startedAt = Date.now()

  // Track in queue
  const entry: JiraProcessingEntry = {
    issueKey,
    state: "processing",
    queuedAt: startedAt,
    startedAt,
  }
  processingQueue.set(issueKey, entry)

  const client = new JiraClient(config)

  try {
    // 1. Fetch issue
    logger.info({ issueKey }, "JIRA: fetching issue")
    const issue = await client.getIssue(issueKey)

    // 2. Process attachments
    const attachmentResult = await processAttachments(
      client,
      issue.fields.attachment ?? [],
      generatedImageDir,
      orchestratorPublicOrigin,
      logger
    )

    // 3. Build instruction message
    const instruction = buildInstructionMessage(issue, attachmentResult)
    logger.info({ issueKey, instructionLength: instruction.length }, "JIRA: built instruction")

    // 4. Determine AI provider and key from env
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
    if (!apiKey) {
      throw new Error("No AI API key configured (need ANTHROPIC_API_KEY or OPENAI_API_KEY)")
    }
    const provider: AgentProvider = process.env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : "openai"
    const model = resolveAgentModel(provider)

    // 5. Set up agent session
    const sessionName = `${config.session}-${issueKey.toLowerCase()}`
    const session = scopedSessionKey(sessionName, config.siteId)
    const tools = createAgentTools(session)
    const systemPrompt = buildAgentSystemPrompt()
    const contextMsg = buildContextMessage(session, { slug: "/" })
    const fullMessage = `${contextMsg}\n\n---\n\nUser request: ${instruction}`

    // 6. Run agent loop
    logger.info({ issueKey, session, provider, model }, "JIRA: starting agent loop")
    const changes: string[] = []
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
              }
            } catch { /* read-only tool result */ }
          }
          break
        case "done":
          summary = event.summary
          toolCallCount = event.toolCallCount
          break
        case "error":
          throw new Error(event.message)
      }
    }

    const durationMs = Date.now() - startedAt
    logger.info({ issueKey, changes: changes.length, durationMs }, "JIRA: agent completed")

    // 7. Auto-publish if enabled
    let published = false
    if (config.autoPublish) {
      try {
        await triggerPublish(session, config.siteId, logger)
        published = true
        logger.info({ issueKey }, "JIRA: auto-published")
      } catch (err) {
        logger.warn({ issueKey, error: err instanceof Error ? err.message : String(err) }, "JIRA: auto-publish failed")
      }
    }

    // 8. Post success comment to JIRA
    const result: JiraProcessingResult = {
      issueKey,
      status: "success",
      summary,
      changes,
      durationMs,
      modelUsed: model,
      published,
    }

    const comment = formatSuccessComment(result, orchestratorPublicOrigin, sessionName, config.siteId)
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

    // 10. Transition ticket to done
    if (config.doneStatus) {
      const transitioned = await client.transitionIssue(issueKey, config.doneStatus).catch(() => false)
      if (transitioned) {
        logger.info({ issueKey, status: config.doneStatus }, "JIRA: transitioned issue")
      }
    }

    // Track completion
    entry.state = "done"
    entry.completedAt = Date.now()
    entry.result = result
    recentResults.unshift(result)
    if (recentResults.length > MAX_RECENT) recentResults.pop()

    return result
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

    entry.state = "error"
    entry.completedAt = Date.now()
    entry.result = result
    recentResults.unshift(result)
    if (recentResults.length > MAX_RECENT) recentResults.pop()

    return result
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
  orchestratorOrigin: string,
  sessionName: string,
  siteId: string
): string {
  const lines: string[] = [
    "**Website updated successfully from this ticket.**",
    "",
  ]

  if (result.changes.length > 0) {
    lines.push("**Changes made:**")
    for (const change of result.changes) {
      lines.push(`- ${change}`)
    }
    lines.push("")
  }

  if (result.summary) {
    lines.push(`**Summary:** ${result.summary}`)
    lines.push("")
  }

  if (result.published) {
    lines.push("**Status:** Published to live site")
  }

  lines.push(`**AI Model:** ${result.modelUsed ?? "unknown"} | **Duration:** ${(result.durationMs / 1000).toFixed(1)}s`)

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
