// Minimal round-trip between Contentful's rich-text JSON document format
// and a plain string. The editor only exposes plain strings for the
// `kind: "richtext"` field, so we flatten on read and wrap on write.
//
// Known limitation: any marks (bold, italic), links, embeds, lists or
// multi-paragraph structure are lost on round-trip. Document this in TODO.

type RichTextNode = {
  nodeType?: string
  value?: string
  content?: RichTextNode[]
}

export function documentToPlainText(doc: unknown): string {
  if (!doc || typeof doc !== "object") return ""
  const node = doc as RichTextNode
  if (typeof node.value === "string") return node.value
  if (Array.isArray(node.content)) {
    const chunks: string[] = []
    for (const child of node.content) {
      const text = documentToPlainText(child)
      if (!text) continue
      chunks.push(text)
    }
    // Preserve paragraph breaks between top-level blocks.
    if (node.nodeType === "document") return chunks.join("\n\n")
    if (node.nodeType === "paragraph" || !node.nodeType) return chunks.join("")
    return chunks.join("\n")
  }
  return ""
}

// Wrap a plain string as a minimal Contentful rich-text document.
// Splits on blank lines to produce one paragraph per chunk.
export function plainTextToDocument(text: string): unknown {
  const paragraphs = text.split(/\n{2,}/).map((chunk) => chunk.trim()).filter(Boolean)
  return {
    nodeType: "document",
    data: {},
    content: paragraphs.map((value) => ({
      nodeType: "paragraph",
      data: {},
      content: [{ nodeType: "text", value, marks: [], data: {} }],
    })),
  }
}
