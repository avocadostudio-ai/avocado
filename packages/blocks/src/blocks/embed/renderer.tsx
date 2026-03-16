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

function buildSrc(embedType: string, url: string): string | null {
  switch (embedType) {
    case "youtube": {
      const id = extractYouTubeId(url)
      return id ? `https://www.youtube.com/embed/${id}` : null
    }
    case "vimeo": {
      const id = extractVimeoId(url)
      return id ? `https://player.vimeo.com/video/${id}` : null
    }
    case "map":
    case "custom":
      return url
    default:
      return null
  }
}

const ratioClass: Record<string, string> = {
  "16:9": "embed-block__frame--16-9",
  "4:3": "embed-block__frame--4-3",
  "1:1": "embed-block__frame--1-1",
}

export function Embed(props: Record<string, unknown>): JSX.Element | null {
  const embedType = String(props.embedType ?? "youtube")
  const url = String(props.url ?? "")
  const title = String(props.title ?? "")
  const aspectRatio = String(props.aspectRatio ?? "16:9")

  const src = buildSrc(embedType, url)
  if (!src) {
    return (
      <section className="embed-block">
        <div className="section__inner">
          <p className="embed-block__error">Invalid embed URL</p>
        </div>
      </section>
    )
  }

  return (
    <section className="embed-block">
      <div className="section__inner">
        <div className={`embed-block__frame ${ratioClass[aspectRatio] ?? ratioClass["16:9"]}`}>
          <iframe
            src={src}
            title={title || "Embedded content"}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        </div>
        {title.length > 0 && (
          <p className="embed-block__caption" data-editable-target="title" data-editable-target-label="title" data-editable-label="title">
            {renderInline(title)}
          </p>
        )}
      </div>
    </section>
  )
}
