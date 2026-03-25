import React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

export function renderFinalMarkdown(text: string) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
}

export function renderSimpleMarkdown(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const elements: (React.ReactNode)[] = []
  let listItems: string[] = []
  let orderedListItems: string[] = []
  let quoteLines: string[] = []
  let tableRows: string[] = []
  let inCodeFence = false
  let codeFenceLanguage = ""
  let codeFenceLines: string[] = []

  const findUnescapedChar = (line: string, target: string, start: number) => {
    for (let i = start; i < line.length; i += 1) {
      if (line[i] !== target) continue
      let backslashes = 0
      for (let j = i - 1; j >= 0 && line[j] === "\\"; j -= 1) backslashes += 1
      if (backslashes % 2 === 0) return i
    }
    return -1
  }

  const sanitizeHref = (href: string) => {
    const value = href.trim()
    if (!value) return null
    if (/^(https?:\/\/|mailto:|tel:|\/|#)/i.test(value)) return value
    return null
  }

  const wrapInlineNode = (node: React.ReactNode, flags: { bold: boolean; italic: boolean; code: boolean }) => {
    if (flags.code) return <code>{node}</code>
    let out = node
    if (flags.bold) out = <strong>{out}</strong>
    if (flags.italic) out = <em>{out}</em>
    return out
  }

  const inlineMarkdown = (line: string): React.ReactNode => {
    const nodes: React.ReactNode[] = []
    let buffer = ""
    let bold = false
    let italic = false
    let code = false

    const flushBuffer = () => {
      if (!buffer) return
      nodes.push(
        <React.Fragment key={`t-${nodes.length}`}>
          {wrapInlineNode(buffer, { bold, italic, code })}
        </React.Fragment>
      )
      buffer = ""
    }

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!
      const next = line[i + 1]

      if (ch === "\\") {
        if (next === "*" || next === "_" || next === "`" || next === "[" || next === "]" || next === "(" || next === ")" || next === "\\") {
          buffer += next
          i += 1
          continue
        }
      }

      if (!code && ch === "[") {
        const labelEnd = findUnescapedChar(line, "]", i + 1)
        if (labelEnd > i && line[labelEnd + 1] === "(") {
          const hrefEnd = findUnescapedChar(line, ")", labelEnd + 2)
          if (hrefEnd > labelEnd + 1) {
            const label = line.slice(i + 1, labelEnd)
            const hrefRaw = line.slice(labelEnd + 2, hrefEnd)
            const href = sanitizeHref(hrefRaw)
            flushBuffer()
            if (href) {
              nodes.push(
                <a key={`a-${nodes.length}-${href}`} href={href} target="_blank" rel="noreferrer">
                  {label || href}
                </a>
              )
            } else {
              nodes.push(
                <React.Fragment key={`a-plain-${nodes.length}`}>
                  {wrapInlineNode(label || hrefRaw, { bold, italic, code })}
                </React.Fragment>
              )
            }
            i = hrefEnd
            continue
          }
        }
      }

      if (!code && ((ch === "*" && next === "*") || (ch === "_" && next === "_"))) {
        flushBuffer()
        bold = !bold
        i += 1
        continue
      }
      if (!code && (ch === "*" || ch === "_")) {
        const prev = i > 0 ? line[i - 1] : " "
        const nextChar = line[i + 1] ?? " "
        const isWordChar = (value: string) => /[A-Za-z0-9]/.test(value)
        if (isWordChar(prev) && isWordChar(nextChar)) {
          buffer += ch
          continue
        }
        flushBuffer()
        italic = !italic
        continue
      }
      if (ch === "`") {
        flushBuffer()
        code = !code
        continue
      }

      buffer += ch
    }
    flushBuffer()

    if (nodes.length === 0) return ""
    return <>{nodes}</>
  }

  const flushList = () => {
    if (listItems.length === 0) return
    elements.push(
      <ul key={`ul-${elements.length}`}>
        {listItems.map((item, i) => (
          <li key={i}>{inlineMarkdown(item)}</li>
        ))}
      </ul>
    )
    listItems = []
  }

  const flushOrderedList = () => {
    if (orderedListItems.length === 0) return
    elements.push(
      <ol key={`ol-${elements.length}`}>
        {orderedListItems.map((item, i) => (
          <li key={i}>{inlineMarkdown(item)}</li>
        ))}
      </ol>
    )
    orderedListItems = []
  }

  const flushQuote = () => {
    if (quoteLines.length === 0) return
    const quoteText = quoteLines.join("\n")
    elements.push(<blockquote key={`q-${elements.length}`}>{inlineMarkdown(quoteText)}</blockquote>)
    quoteLines = []
  }

  const flushCodeFence = () => {
    if (!inCodeFence) return
    const codeText = codeFenceLines.join("\n")
    elements.push(
      <pre key={`pre-${elements.length}`}>
        <code className={codeFenceLanguage ? `language-${codeFenceLanguage}` : undefined}>{codeText}</code>
      </pre>
    )
    inCodeFence = false
    codeFenceLanguage = ""
    codeFenceLines = []
  }

  const flushTable = () => {
    if (tableRows.length === 0) return
    const parseCells = (row: string) =>
      row.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim())
    const isSeparator = (row: string) => /^\|[\s\-:|]+\|$/.test(row)

    const headerCells = parseCells(tableRows[0])
    const bodyRows = tableRows.slice(1).filter(r => !isSeparator(r))

    elements.push(
      <table key={`table-${elements.length}`}>
        <thead>
          <tr>{headerCells.map((c, i) => <th key={i}>{inlineMarkdown(c)}</th>)}</tr>
        </thead>
        <tbody>
          {bodyRows.map((row, ri) => (
            <tr key={ri}>
              {parseCells(row).map((c, ci) => <td key={ci}>{inlineMarkdown(c)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    )
    tableRows = []
  }

  const flushLists = () => {
    flushList()
    flushOrderedList()
  }

  const flushFlowBlocks = () => {
    flushLists()
    flushQuote()
    flushTable()
  }

  const pushHeading = (level: number, content: string) => {
    const key = `h-${elements.length}`
    if (level === 1) elements.push(<h1 key={key}>{inlineMarkdown(content)}</h1>)
    else if (level === 2) elements.push(<h2 key={key}>{inlineMarkdown(content)}</h2>)
    else if (level === 3) elements.push(<h3 key={key}>{inlineMarkdown(content)}</h3>)
    else if (level === 4) elements.push(<h4 key={key}>{inlineMarkdown(content)}</h4>)
    else if (level === 5) elements.push(<h5 key={key}>{inlineMarkdown(content)}</h5>)
    else elements.push(<h6 key={key}>{inlineMarkdown(content)}</h6>)
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (inCodeFence) {
      if (/^```/.test(trimmed)) {
        flushCodeFence()
      } else {
        codeFenceLines.push(line)
      }
      continue
    }

    if (/^```/.test(trimmed)) {
      flushFlowBlocks()
      inCodeFence = true
      codeFenceLanguage = trimmed.slice(3).trim()
      codeFenceLines = []
      continue
    }

    if (/^\|.+\|$/.test(trimmed)) {
      flushLists()
      flushQuote()
      tableRows.push(trimmed)
      continue
    }
    flushTable()

    const quoteMatch = /^\s*>\s?(.*)$/.exec(line)
    if (quoteMatch) {
      flushLists()
      quoteLines.push(quoteMatch[1] ?? "")
      continue
    }
    flushQuote()

    const orderedListMatch = /^\s*\d+\.\s+(.+)$/.exec(line)
    if (orderedListMatch) {
      flushList()
      orderedListItems.push(orderedListMatch[1]!)
      continue
    }

    const listMatch = /^\s*[-*•]\s+(.+)$/.exec(line)
    if (listMatch) {
      flushOrderedList()
      listItems.push(listMatch[1])
      continue
    }
    flushLists()

    const headingMatch = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line)
    if (headingMatch) {
      const level = Math.min(6, Math.max(1, headingMatch[1]?.length ?? 1))
      const content = headingMatch[2] ?? ""
      pushHeading(level, content)
      continue
    }

    if (trimmed === "") {
      continue
    }
    elements.push(<p key={`p-${elements.length}`}>{inlineMarkdown(line)}</p>)
  }
  flushLists()
  flushQuote()
  flushTable()
  flushCodeFence()

  return <>{elements}</>
}
