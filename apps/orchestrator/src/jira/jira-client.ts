/**
 * JIRA REST API client.
 *
 * Supports both JIRA Cloud (Basic auth: email + API token) and
 * JIRA Server/Data Center (Bearer token / PAT).
 *
 * Uses only native fetch — no external HTTP library needed.
 */

import type { JiraIssue, JiraAttachment, JiraTransition, JiraConfig } from "./jira-types.js"

export class JiraClient {
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly isCloud: boolean

  constructor(config: Pick<JiraConfig, "baseUrl" | "email" | "apiToken">) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "")
    this.isCloud = this.baseUrl.includes(".atlassian.net")

    if (this.isCloud && config.email) {
      // Cloud: Basic auth with email:apiToken
      const creds = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")
      this.authHeader = `Basic ${creds}`
    } else {
      // Server/Data Center: Bearer PAT
      this.authHeader = `Bearer ${config.apiToken}`
    }
  }

  // ---------------------------------------------------------------------------
  // Core HTTP
  // ---------------------------------------------------------------------------

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}/rest/api/${this.isCloud ? "3" : "2"}${path}`
    const res = await fetch(url, {
      ...options,
      headers: {
        "Authorization": this.authHeader,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(options?.headers as Record<string, string> | undefined),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`JIRA API ${res.status}: ${res.statusText} — ${body.slice(0, 500)}`)
    }
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  // ---------------------------------------------------------------------------
  // Issue operations
  // ---------------------------------------------------------------------------

  async getIssue(issueKey: string): Promise<JiraIssue> {
    return this.request<JiraIssue>(`/issue/${encodeURIComponent(issueKey)}?fields=summary,description,status,labels,attachment,reporter,assignee,creator,comment`)
  }

  async getIssueAttachments(issueKey: string): Promise<JiraAttachment[]> {
    const issue = await this.getIssue(issueKey)
    return issue.fields.attachment ?? []
  }

  /**
   * Download an attachment binary. The `content` URL from JIRA requires the
   * same auth header, so we can't just fetch it unauthenticated.
   */
  async downloadAttachment(contentUrl: string): Promise<Buffer> {
    const res = await fetch(contentUrl, {
      headers: {
        "Authorization": this.authHeader,
        "Accept": "*/*",
      },
    })
    if (!res.ok) {
      throw new Error(`JIRA attachment download failed: ${res.status} ${res.statusText}`)
    }
    return Buffer.from(await res.arrayBuffer())
  }

  // ---------------------------------------------------------------------------
  // Feedback operations
  // ---------------------------------------------------------------------------

  async addComment(issueKey: string, markdown: string): Promise<void> {
    if (this.isCloud) {
      // Cloud API v3 uses Atlassian Document Format
      await this.request(`/issue/${encodeURIComponent(issueKey)}/comment`, {
        method: "POST",
        body: JSON.stringify({
          body: markdownToAdf(markdown),
        }),
      })
    } else {
      // Server API v2 uses plain text/wiki markup
      await this.request(`/issue/${encodeURIComponent(issueKey)}/comment`, {
        method: "POST",
        body: JSON.stringify({ body: markdown }),
      })
    }
  }

  /**
   * Transition an issue to a target status by name.
   * Looks up available transitions to find the matching one.
   */
  async transitionIssue(issueKey: string, targetStatusName: string): Promise<boolean> {
    const res = await this.request<{ transitions: JiraTransition[] }>(
      `/issue/${encodeURIComponent(issueKey)}/transitions`
    )
    const match = res.transitions.find(
      (t) => t.name.toLowerCase() === targetStatusName.toLowerCase() ||
             t.to.name.toLowerCase() === targetStatusName.toLowerCase()
    )
    if (!match) return false

    await this.request(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } }),
    })
    return true
  }

  /**
   * Assign an issue to a user by account ID (Cloud) or username (Server).
   */
  async assignIssue(issueKey: string, assignee: { accountId?: string; name?: string }): Promise<void> {
    await this.request(`/issue/${encodeURIComponent(issueKey)}/assignee`, {
      method: "PUT",
      body: JSON.stringify(this.isCloud ? { accountId: assignee.accountId } : { name: assignee.name }),
    })
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  async searchJql(jql: string, maxResults = 20): Promise<JiraIssue[]> {
    // Cloud deprecated `/search` in favor of `/search/jql` (changelog CHANGE-2046).
    // The new endpoint keeps the same `issues[]` response shape; we don't need
    // pagination (maxResults is capped at 100) so nextPageToken is ignored.
    // Server/DC still uses the legacy `/search` on API v2.
    const path = this.isCloud ? "/search/jql" : "/search"
    const res = await this.request<{ issues: JiraIssue[] }>(
      `${path}?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,description,status,labels,attachment,reporter,assignee,creator,comment`
    )
    return res.issues ?? []
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert simple markdown text to Atlassian Document Format (ADF).
 * Handles paragraphs, bulletLists, bold (**text**), and links ([label](url)).
 * Good enough for status/clarification comments.
 */
export function markdownToAdf(markdown: string): object {
  const lines = markdown.split("\n")
  const content: object[] = []

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") { i++; continue }

    // Bullet list: consecutive lines starting with "- "
    if (/^\s*-\s+/.test(line)) {
      const items: object[] = []
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*-\s+/, "")
        items.push({
          type: "listItem",
          content: [{ type: "paragraph", content: parseInlineMarkdown(itemText) }],
        })
        i++
      }
      content.push({ type: "bulletList", content: items })
      continue
    }

    content.push({ type: "paragraph", content: parseInlineMarkdown(line) })
    i++
  }

  return { version: 1, type: "doc", content }
}

/**
 * Parse inline markdown (bold + links) into ADF inline nodes.
 * Scans left-to-right, handling **bold** and [label](url) as first-class constructs
 * and falling through to plain text between them.
 */
function parseInlineMarkdown(text: string): object[] {
  const nodes: object[] = []
  let i = 0

  function pushText(raw: string, marks?: object[]) {
    if (!raw) return
    const node: Record<string, unknown> = { type: "text", text: raw }
    if (marks && marks.length) node.marks = marks
    nodes.push(node)
  }

  while (i < text.length) {
    // Bold: **...**
    if (text[i] === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2)
      if (end !== -1) {
        pushText(text.slice(i + 2, end), [{ type: "strong" }])
        i = end + 2
        continue
      }
    }

    // Inline code: `...`
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1)
      if (end !== -1) {
        pushText(text.slice(i + 1, end), [{ type: "code" }])
        i = end + 1
        continue
      }
    }

    // Link: [label](url)
    if (text[i] === "[") {
      const labelEnd = text.indexOf("]", i + 1)
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const urlEnd = text.indexOf(")", labelEnd + 2)
        if (urlEnd !== -1) {
          const label = text.slice(i + 1, labelEnd)
          const url = text.slice(labelEnd + 2, urlEnd)
          nodes.push({
            type: "text",
            text: label,
            marks: [{ type: "link", attrs: { href: url } }],
          })
          i = urlEnd + 1
          continue
        }
      }
    }

    // Plain run up to the next special char
    let next = text.length
    for (const marker of ["**", "[", "`"]) {
      const idx = text.indexOf(marker, i)
      if (idx !== -1 && idx < next) next = idx
    }
    if (next === i) next = i + 1
    pushText(text.slice(i, next))
    i = next
  }

  if (nodes.length === 0) nodes.push({ type: "text", text })
  return nodes
}
