import { useEditor, EditorContent, type Editor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Link from "@tiptap/extension-link"
import Underline from "@tiptap/extension-underline"
import { Markdown } from "tiptap-markdown"
import { useEffect, useRef, useCallback } from "react"
import { Bold, Italic, Underline as UnderlineIcon, Heading2, Heading3, List, ListOrdered, Link2 } from "lucide-react"

type Props = {
  value: string
  onChange: (markdown: string) => void
  onFocus?: () => void
  onBlur?: () => void
}

const ICON_SIZE = 14

const extensions = [
  StarterKit.configure({ heading: { levels: [2, 3] } }),
  Link.configure({ openOnClick: false }),
  Underline,
  Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
]

function getMarkdown(editor: Editor): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const md = (editor.storage as any).markdown?.getMarkdown?.()
  return typeof md === "string" ? md : ""
}

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={`rte-toolbar-btn${active ? " is-active" : ""}`}
      onClick={onClick}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  const addLink = useCallback(() => {
    const prev = editor.getAttributes("link").href ?? ""
    const url = window.prompt("URL", prev)
    if (url === null) return
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run()
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
    }
  }, [editor])

  return (
    <div className="rte-toolbar">
      <ToolbarButton active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
        <Bold size={ICON_SIZE} />
      </ToolbarButton>
      <ToolbarButton active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
        <Italic size={ICON_SIZE} />
      </ToolbarButton>
      <ToolbarButton active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline">
        <UnderlineIcon size={ICON_SIZE} />
      </ToolbarButton>

      <span className="rte-toolbar-sep" />

      <ToolbarButton active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2">
        <Heading2 size={ICON_SIZE} />
      </ToolbarButton>
      <ToolbarButton active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Heading 3">
        <Heading3 size={ICON_SIZE} />
      </ToolbarButton>

      <span className="rte-toolbar-sep" />

      <ToolbarButton active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
        <List size={ICON_SIZE} />
      </ToolbarButton>
      <ToolbarButton active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Ordered list">
        <ListOrdered size={ICON_SIZE} />
      </ToolbarButton>

      <span className="rte-toolbar-sep" />

      <ToolbarButton active={editor.isActive("link")} onClick={addLink} title="Link">
        <Link2 size={ICON_SIZE} />
      </ToolbarButton>
    </div>
  )
}

export function RichTextEditorField({ value, onChange, onFocus, onBlur }: Props) {
  const suppressUpdateRef = useRef(false)
  const lastExternalValueRef = useRef(value)

  const editor = useEditor({
    extensions,
    content: value,
    onUpdate: ({ editor: e }) => {
      if (suppressUpdateRef.current) return
      const md = getMarkdown(e as Editor)
      lastExternalValueRef.current = md
      onChange(md)
    },
    onFocus: () => onFocus?.(),
    onBlur: () => onBlur?.(),
  })

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (value === lastExternalValueRef.current) return
    lastExternalValueRef.current = value

    suppressUpdateRef.current = true
    const { from, to } = editor.state.selection
    editor.commands.setContent(value)
    const docSize = editor.state.doc.content.size
    const safeFrom = Math.min(from, docSize)
    const safeTo = Math.min(to, docSize)
    try {
      editor.commands.setTextSelection({ from: safeFrom, to: safeTo })
    } catch {
      // Selection may be out of range after content replacement
    }
    suppressUpdateRef.current = false
  }, [value, editor])

  if (!editor) return null

  return (
    <div className="rte-wrap">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className="rte-content" />
    </div>
  )
}
