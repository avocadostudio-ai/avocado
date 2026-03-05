import { NextResponse } from "next/server"
import { buildEditorComponentsManifest } from "../../../../lib/editor-components-manifest"

export async function GET(request: Request) {
  const manifest = buildEditorComponentsManifest()
  const origin = request.headers.get("origin") ?? "*"
  return NextResponse.json(manifest, {
    headers: {
      "cache-control": "no-store",
      "access-control-allow-origin": origin,
      vary: "Origin"
    }
  })
}
