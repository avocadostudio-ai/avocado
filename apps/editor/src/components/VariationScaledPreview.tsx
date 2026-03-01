import { useEffect, useRef, useState, type CSSProperties } from "react"
import { SharedBlockRenderer } from "@ai-site-editor/blocks"
import type { BlockInstance } from "@ai-site-editor/shared"

export function VariationScaledPreview(args: { block: BlockInstance; virtualWidth: number }) {
  const shellRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [shellWidth, setShellWidth] = useState(0)
  const [contentHeight, setContentHeight] = useState(240)

  useEffect(() => {
    if (!shellRef.current) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      setShellWidth(Math.max(0, width))
    })
    observer.observe(shellRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!canvasRef.current) return
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 240
      setContentHeight(Math.max(120, height))
    })
    observer.observe(canvasRef.current)
    return () => observer.disconnect()
  }, [args.block.id, args.block.type, args.block.props, args.virtualWidth])

  const scale = shellWidth > 0 ? Math.min(1, shellWidth / args.virtualWidth) : 1
  const scaledHeight = Math.max(170, Math.ceil(contentHeight * scale))

  return (
    <div className="variation-live-preview">
      <div ref={shellRef} className="variation-live-preview-shell" style={{ height: scaledHeight }}>
        <div
          ref={canvasRef}
          className="variation-live-preview-canvas"
          style={
            {
              width: `${args.virtualWidth}px`,
              transform: `scale(${scale})`,
              transformOrigin: "top left"
            } satisfies CSSProperties
          }
        >
          <SharedBlockRenderer block={args.block} />
        </div>
      </div>
    </div>
  )
}
