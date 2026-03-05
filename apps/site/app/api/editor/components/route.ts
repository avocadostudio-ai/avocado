import { NextResponse } from "next/server"
import { buildEditorComponentsManifest } from "../../../../lib/editor-components-manifest"

export async function GET() {
  const manifest = buildEditorComponentsManifest()
  return NextResponse.json(manifest, {
    headers: {
      "cache-control": "no-store"
    }
  })
}
