#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-all}"
SCOPE="${VERCEL_SCOPE:-adventure-arena-ch}"
SITE_PROJECT="${VERCEL_SITE_PROJECT:-avocado-site}"
EDITOR_PROJECT="${VERCEL_EDITOR_PROJECT:-avocado-editor}"

if ! command -v vercel >/dev/null 2>&1; then
  echo "vercel CLI not found on PATH. Install it first: brew install vercel-cli"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this check. Install it first: brew install jq"
  exit 1
fi

PROJECTS_JSON="$(vercel api /v9/projects --scope "$SCOPE" --raw)"

project_id_for() {
  local name="$1"
  local id
  id="$(jq -r --arg name "$name" '.projects[] | select(.name == $name) | .id' <<<"$PROJECTS_JSON" | head -n 1)"
  if [[ -z "$id" || "$id" == "null" ]]; then
    echo "Project not found in scope '$SCOPE': $name" >&2
    return 1
  fi
  printf '%s\n' "$id"
}

print_project_envs() {
  local project_name="$1"
  local project_id
  project_id="$(project_id_for "$project_name")"

  local env_json
  env_json="$(vercel api "/v10/projects/${project_id}/env" --scope "$SCOPE" --raw)"

  local count
  count="$(jq '.envs | length' <<<"$env_json")"

  echo "Project: ${project_name} (${project_id})"
  echo "Scope: ${SCOPE}"
  echo "Env var count: ${count}"
  jq -r '.envs[] | "- " + .key + " [" + ((.target // []) | join(",")) + "]"' <<<"$env_json"
  echo
}

case "$TARGET" in
  site)
    print_project_envs "$SITE_PROJECT"
    ;;
  editor)
    print_project_envs "$EDITOR_PROJECT"
    ;;
  all)
    print_project_envs "$SITE_PROJECT"
    print_project_envs "$EDITOR_PROJECT"
    ;;
  *)
    echo "Usage: $0 [all|site|editor]"
    echo "Optional env overrides: VERCEL_SCOPE, VERCEL_SITE_PROJECT, VERCEL_EDITOR_PROJECT"
    exit 1
    ;;
esac
