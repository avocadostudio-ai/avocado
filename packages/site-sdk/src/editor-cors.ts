let cachedOrigins: Set<string> | undefined

export function getEditorCorsOrigins(): Set<string> {
  if (cachedOrigins) return cachedOrigins
  const defaults = ["http://localhost:4100"]
  const extra = (process.env.EDITOR_CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  cachedOrigins = new Set([...defaults, ...extra])
  return cachedOrigins
}

export function applyEditorCors(response: Response, requestOrigin: string | null): Response {
  const vary = response.headers.get("Vary") ?? ""
  const hasOrigin = vary.split(",").map((v) => v.trim().toLowerCase()).includes("origin")
  if (!hasOrigin) response.headers.append("Vary", "Origin")

  if (!requestOrigin) return response

  if (!getEditorCorsOrigins().has(requestOrigin)) return response

  response.headers.set("Access-Control-Allow-Origin", requestOrigin)
  response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS")
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization")
  return response
}

export function createEditorCorsOptionsHandler(): (request: Request) => Response {
  return (request: Request) => {
    return applyEditorCors(new Response(null, { status: 204 }), request.headers.get("origin"))
  }
}
