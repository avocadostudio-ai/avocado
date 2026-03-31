import type { PuckHostApi } from "./types"

let hostApi: PuckHostApi | null = null

export function setPuckHostApi(host: PuckHostApi) {
  hostApi = host
}

export function getPuckHostApi(): PuckHostApi {
  if (!hostApi) {
    throw new Error("Puck host API is not configured")
  }
  return hostApi
}
