// Stub for next/image in the Vite editor environment.
// Block renderers import next/image for Next.js optimization;
// in Vite we fall back to a plain <img>.
export default function StubImage(props: Record<string, unknown>) {
  const { fill, sizes, priority, quality, placeholder, blurDataURL, ...rest } = props
  return <img {...rest} />
}
