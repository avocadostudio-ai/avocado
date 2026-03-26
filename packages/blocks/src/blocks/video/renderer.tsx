"use client"

import { useState, type JSX } from "react"
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

function buildEmbedUrl(type: "youtube" | "vimeo", id: string, autoplay: boolean, loop: boolean): string {
  if (type === "youtube") {
    const params = new URLSearchParams()
    params.set("autoplay", "1")
    if (loop) params.set("loop", "1")
    return `https://www.youtube.com/embed/${id}?${params.toString()}`
  }
  const params = new URLSearchParams()
  params.set("autoplay", "1")
  if (loop) params.set("loop", "1")
  return `https://player.vimeo.com/video/${id}?${params.toString()}`
}

function EmbedFacade({ type, videoId, title, autoplay, loop }: {
  type: "youtube" | "vimeo"
  videoId: string
  title: string
  autoplay: boolean
  loop: boolean
}) {
  const [activated, setActivated] = useState(autoplay)

  if (activated) {
    return (
      <iframe
        src={buildEmbedUrl(type, videoId, true, loop)}
        title={title || "Video"}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    )
  }

  const thumbUrl = type === "youtube"
    ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    : undefined

  return (
    <button
      type="button"
      className="video-block__facade"
      onClick={() => setActivated(true)}
      aria-label={`Play ${title || "video"}`}
    >
      {thumbUrl && <img src={thumbUrl} alt="" className="video-block__facade-thumb" loading="lazy" />}
      <svg className="video-block__facade-play" viewBox="0 0 68 48" aria-hidden="true">
        <path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55C3.97 2.33 2.27 4.81 1.48 7.74.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="currentColor"/>
        <path d="M45 24L27 14v20" fill="#fff"/>
      </svg>
    </button>
  )
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
            <EmbedFacade
              type="youtube"
              videoId={extractYouTubeId(src)!}
              title={title}
              autoplay={autoplay}
              loop={loop}
            />
          )}
          {sourceType === "vimeo" && (
            <EmbedFacade
              type="vimeo"
              videoId={extractVimeoId(src)!}
              title={title}
              autoplay={autoplay}
              loop={loop}
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
