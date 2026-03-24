import { useEffect, useRef, useState } from "react"

export function SiteTileDesktopPreview(args: { title: string; src: string; onClick?: () => void }) {
  const shellRef = useRef<HTMLDivElement>(null)
  const [shellWidth, setShellWidth] = useState(0)
  const virtualWidth = 1200
  const virtualHeight = 760

  useEffect(() => {
    if (!shellRef.current) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      setShellWidth(Math.max(0, width))
    })
    observer.observe(shellRef.current)
    return () => observer.disconnect()
  }, [])

  const scale = shellWidth > 0 ? Math.min(1, shellWidth / virtualWidth) : 1
  const scaledHeight = Math.max(170, Math.ceil(virtualHeight * scale))

  return (
    <div ref={shellRef} className="site-tile-preview" style={{ height: scaledHeight, cursor: args.onClick ? "pointer" : undefined }} onClick={args.onClick}>
      <iframe
        title={args.title}
        src={args.src}
        loading="lazy"
        style={{
          width: `${virtualWidth}px`,
          height: `${virtualHeight}px`,
          transform: `scale(${scale})`,
          transformOrigin: "top left"
        }}
      />
    </div>
  )
}
