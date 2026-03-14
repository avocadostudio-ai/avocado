#!/usr/bin/env bash
set -euo pipefail

SITE_URL="${SITE_URL:-http://localhost:3000}"
EDITOR_URL="${EDITOR_URL:-http://localhost:4100}"
ORCH_URL="${ORCH_URL:-http://localhost:4200}"
SESSION="${SESSION:-dev}"
SITE_ID="${SITE_ID:-avocado-stories}"
REQUIRE_GENERIC_BASELINE="${REQUIRE_GENERIC_BASELINE:-0}"

red() { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

fail() {
  red "FAIL: $*"
  exit 1
}

check_http_ok() {
  local name="$1"
  local url="$2"
  local code
  code="$(curl -sS -o /dev/null -w "%{http_code}" "$url" || true)"
  if [[ "$code" != "200" ]]; then
    fail "$name is not healthy at $url (http $code)"
  fi
  green "OK: $name healthy ($url)"
}

echo "== Avocado Transformation Demo Check =="
echo "Site URL: $SITE_URL"
echo "Editor URL: $EDITOR_URL"
echo "Orchestrator URL: $ORCH_URL"
echo "Session/Site: $SESSION / $SITE_ID"
echo

check_http_ok "Site" "$SITE_URL/"
check_http_ok "Editor" "$EDITOR_URL/"

health="$(curl -sS "$ORCH_URL/health" || true)"
if [[ "$health" != '{"ok":true}' ]]; then
  fail "Orchestrator health is unexpected: $health"
fi
green "OK: Orchestrator healthy"

echo
echo "== Draft baseline probe =="

slugs_json="$(curl -sS "$ORCH_URL/draft/slugs?session=$SESSION&siteId=$SITE_ID" || true)"
echo "Slugs response: $slugs_json"

if ! grep -q '"slugs"' <<<"$slugs_json"; then
  fail "Unable to read draft slugs."
fi

home_json="$(curl -sS "$ORCH_URL/draft/pages?session=$SESSION&siteId=$SITE_ID&slug=/" || true)"
if grep -q '"error"' <<<"$home_json"; then
  fail "Unable to read home page draft for site '$SITE_ID': $home_json"
fi

hero_heading="$(
  jq -r '
    (.blocks // [])
    | map(select(.type == "Hero") | .props.heading)
    | map(select(type == "string" and length > 0))
    | .[0] // ""
  ' <<<"$home_json"
)"

if [[ -z "$hero_heading" ]]; then
  fail "Home page has no hero heading."
fi

echo "Home hero heading: $hero_heading"

if [[ "$hero_heading" == "Build websites with plain language" ]]; then
  green "OK: Generic baseline detected (ideal for transformation narrative)."
else
  yellow "WARN: Baseline is already customized. Transformation contrast may be weaker."
  if [[ "$REQUIRE_GENERIC_BASELINE" == "1" ]]; then
    fail "REQUIRE_GENERIC_BASELINE=1 and generic heading was not found."
  fi
fi

echo
echo "== Publish proof guidance =="
echo "After clicking Publish in the editor, validate with:"
echo "  curl -sS \"$ORCH_URL/publish/status?session=$SESSION&siteId=$SITE_ID\""
echo "Expected: status payload exists and vercelState/status indicates triggered or ready."
echo
green "Demo preflight check passed."
