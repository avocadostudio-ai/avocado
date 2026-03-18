"use client"

import NextImage from "next/image"

export type BlockImageProps = {
  src: string
  alt: string
  width?: number
  height?: number
  fill?: boolean
  sizes?: string
  loading?: "lazy" | "eager"
  priority?: boolean
  className?: string
  "data-editable-label"?: string
  [key: string]: unknown
}

export function BlockImage({ fill, sizes, priority, loading, ...rest }: BlockImageProps) {
  if (fill) {
    const { width, height, ...fillRest } = rest
    return <NextImage fill sizes={sizes} priority={priority} loading={priority ? undefined : loading} {...fillRest} />
  }
  return (
    <NextImage
      width={rest.width ?? 0}
      height={rest.height ?? 0}
      sizes={sizes}
      priority={priority}
      loading={priority ? undefined : loading}
      {...rest}
    />
  )
}
