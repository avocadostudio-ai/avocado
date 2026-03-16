import type { JSX } from "react"
import { renderInline } from "../_shared"

function extractYouTubeId(url: string): string | null {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?.*v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/
  )
  return match?.[1] ?? null
}

function extractVimeoId(url: string): string | null {
  const match = url.match(/vimeo\.com\/(\d+)/)
  return match?.[1] ?? null
}

function detectSourceType(src: string): "youtube" | "vimeo" | "direct" {
  if (extractYouTubeId(src)) return "youtube"
  if (extractVimeoId(src)) return "vimeo"
  return "direct"
}

export function Video(props: Record<string, unknown>): JSX.Element {
  const src = String(props.src ?? "")
  const title = String(props.title ?? "")
  const posterUrl = String(props.posterUrl ?? "")
  const autoplay = String(props.autoplay) === "true"
  const loop = String(props.loop) === "true"

  const sourceType = detectSourceType(src)

  return (
    <section className="video-block">
      <div className="section__inner">
        <div className="video-block__frame">
          {sourceType === "youtube" && (
            <iframe
              src={`https://www.youtube.com/embed/${extractYouTubeId(src)}${autoplay ? "?autoplay=1" : ""}${loop ? `${autoplay ? "&" : "?"}loop=1` : ""}`}
              title={title || "YouTube video"}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          )}
          {sourceType === "vimeo" && (
            <iframe
              src={`https://player.vimeo.com/video/${extractVimeoId(src)}${autoplay ? "?autoplay=1" : ""}${loop ? `${autoplay ? "&" : "?"}loop=1` : ""}`}
              title={title || "Vimeo video"}
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
            />
          )}
          {sourceType === "direct" && (
            <video
              src={src}
              poster={posterUrl || undefined}
              controls
              autoPlay={autoplay}
              loop={loop}
              playsInline
              preload="metadata"
            />
          )}
        </div>
        {title.length > 0 && (
          <p className="video-block__caption" data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {renderInline(title)}
          </p>
        )}
      </div>
    </section>
  )
}
