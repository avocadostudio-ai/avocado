#!/usr/bin/env bash
set -euo pipefail

SITE_ORIGIN="${1:-http://localhost:3000}"
ENDPOINT="${SITE_ORIGIN%/}/api/editor/blocks"

echo "Checking manifest endpoint: ${ENDPOINT}"

HTTP_CODE="$(curl -sS -o /tmp/ai-site-editor-manifest.json -w "%{http_code}" "${ENDPOINT}")"
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "FAIL: expected HTTP 200, got ${HTTP_CODE}"
  exit 1
fi

node <<'NODE'
const fs = require("node:fs")
const payload = JSON.parse(fs.readFileSync("/tmp/ai-site-editor-manifest.json", "utf8"))
if (!payload || typeof payload !== "object") {
  console.error("FAIL: response is not a JSON object")
  process.exit(1)
}
if (!Number.isInteger(payload.version) || payload.version <= 0) {
  console.error("FAIL: 'version' must be a positive integer")
  process.exit(1)
}
if (!Array.isArray(payload.components) || payload.components.length === 0) {
  console.error("FAIL: 'components' must be a non-empty array")
  process.exit(1)
}
const invalidType = payload.components.find((item) => !item || typeof item.type !== "string" || item.type.trim().length === 0)
if (invalidType) {
  console.error("FAIL: each component must include a non-empty string 'type'")
  process.exit(1)
}
console.log(`PASS: version=${payload.version}, components=${payload.components.length}`)
NODE
