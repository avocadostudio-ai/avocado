#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

ANTHROPIC_KEYS_URL="https://console.anthropic.com/settings/keys"
OPENAI_KEYS_URL="https://platform.openai.com/api-keys"

# --- Flags -----------------------------------------------------------------
# --dry-run: print what would be written to .env and skip pnpm install.
#            Useful for testing the flow without touching real files.

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--dry-run]

  --dry-run   Walk through the interactive flow without modifying .env
              or running pnpm install. Prints intended writes instead.
EOF
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

# --- Portable helpers ------------------------------------------------------

# In-place sed that works on both macOS (BSD sed) and Linux (GNU sed).
sed_inplace() {
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# Open a URL in the user's default browser, quietly. Returns 0 even if no
# opener is available — the URL is always printed as a fallback.
open_url() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}

# Write a key to .env, replacing the placeholder line. In dry-run mode, just
# print the intended change to stderr instead of touching the file.
write_key() {
  local var="$1" value="$2"
  if (( DRY_RUN )); then
    local masked="${value:0:7}…${value: -4}"
    echo -e "  ${DIM}[dry-run]${NC} would write ${BOLD}${var}=${masked}${NC} to $ENV_FILE" >&2
    return 0
  fi
  # Escape pipes in the value for sed.
  local escaped
  escaped=$(printf '%s' "$value" | sed 's/[|&]/\\&/g')
  sed_inplace "s|^${var}=.*|${var}=${escaped}|" "$ENV_FILE"
}

# Validate a key by pinging the provider. Returns 0 if accepted, 1 otherwise.
# Outputs a one-line human-readable status on stderr.
validate_anthropic_key() {
  local key="$1"
  local status
  status=$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 10 \
    -H "x-api-key: $key" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' \
    https://api.anthropic.com/v1/messages 2>/dev/null || echo "000")
  case "$status" in
    200) return 0 ;;
    401|403) echo "key rejected (HTTP $status) — check it was copied in full" >&2; return 1 ;;
    429) echo "rate-limited (HTTP 429) — key looks valid, continuing" >&2; return 0 ;;
    000) echo "couldn't reach api.anthropic.com — skipping validation" >&2; return 0 ;;
    *) echo "unexpected response (HTTP $status) — saving key anyway" >&2; return 0 ;;
  esac
}

validate_openai_key() {
  local key="$1"
  local status
  status=$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 10 \
    -H "Authorization: Bearer $key" \
    https://api.openai.com/v1/models 2>/dev/null || echo "000")
  case "$status" in
    200) return 0 ;;
    401|403) echo "key rejected (HTTP $status) — check it was copied in full" >&2; return 1 ;;
    429) echo "rate-limited (HTTP 429) — key looks valid, continuing" >&2; return 0 ;;
    000) echo "couldn't reach api.openai.com — skipping validation" >&2; return 0 ;;
    *) echo "unexpected response (HTTP $status) — saving key anyway" >&2; return 0 ;;
  esac
}

validate_gemini_key() {
  local key="$1"
  local status
  status=$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 10 \
    "https://generativelanguage.googleapis.com/v1beta/models?key=$key" 2>/dev/null || echo "000")
  case "$status" in
    200) return 0 ;;
    400|401|403) echo "key rejected (HTTP $status) — check it was copied in full" >&2; return 1 ;;
    429) echo "rate-limited (HTTP 429) — key looks valid, continuing" >&2; return 0 ;;
    000) echo "couldn't reach generativelanguage.googleapis.com — skipping validation" >&2; return 0 ;;
    *) echo "unexpected response (HTTP $status) — saving key anyway" >&2; return 0 ;;
  esac
}

validate_unsplash_key() {
  local key="$1"
  local status
  status=$(curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 10 \
    -H "Authorization: Client-ID $key" \
    "https://api.unsplash.com/photos/random?count=1" 2>/dev/null || echo "000")
  case "$status" in
    200) return 0 ;;
    401|403) echo "key rejected (HTTP $status) — check it was copied in full" >&2; return 1 ;;
    429) echo "rate-limited (HTTP 429) — key looks valid, continuing" >&2; return 0 ;;
    000) echo "couldn't reach api.unsplash.com — skipping validation" >&2; return 0 ;;
    *) echo "unexpected response (HTTP $status) — saving key anyway" >&2; return 0 ;;
  esac
}

# Abort the setup cleanly — the app is non-functional without a key, so we
# refuse to continue rather than leaving the dev with a broken install.
abort_no_key() {
  echo "" >&2
  echo -e "${YELLOW}Setup aborted — an API key is required.${NC}" >&2
  echo "" >&2
  echo "Avocado Studio is useless without an LLM. Get a key and re-run:" >&2
  echo -e "  ${BOLD}Anthropic:${NC} $ANTHROPIC_KEYS_URL" >&2
  echo -e "  ${BOLD}OpenAI:${NC}    $OPENAI_KEYS_URL" >&2
  echo "" >&2
  echo -e "Then: ${BOLD}pnpm dev:setup${NC}" >&2
  echo "" >&2
  exit 1
}

# Prompt for a key, attempt validation, retry on hard rejection.
# Args: <provider-label> <validator-fn> <keys-url>
# Echoes the accepted key on stdout. Aborts the script if the user gives up
# (empty input) or exhausts retries — there is no "continue without a key"
# path because the app doesn't work without one.
prompt_and_validate() {
  local label="$1" validator="$2" url="$3"
  local key=""
  local attempt=0
  while (( attempt < 3 )); do
    attempt=$(( attempt + 1 ))
    printf "%b" "Paste your ${label} API key (Ctrl+C to abort): " >&2
    read -r key
    if [[ -z "$key" ]]; then
      abort_no_key
    fi
    printf "  validating... " >&2
    if "$validator" "$key"; then
      printf "%bok%b\n" "$GREEN" "$NC" >&2
      printf '%s' "$key"
      return 0
    else
      printf "%bfailed%b\n" "$YELLOW" "$NC" >&2
      echo "  create a new key at: $url" >&2
    fi
  done
  echo "  giving up after 3 failed attempts." >&2
  abort_no_key
}

# Prompt for an OPTIONAL key (asset sources, image-gen providers).
# Unlike prompt_and_validate, empty input and validation failure both just
# skip the feature instead of aborting — these sources are nice-to-have.
# Echoes the key on stdout and returns 0 when a key is captured, 1 when skipped.
prompt_optional_and_validate() {
  local label="$1" validator="$2"
  local key=""
  printf "  Paste your ${label} API key (Enter to skip): " >&2
  read -r key
  if [[ -z "$key" ]]; then
    echo -e "  ${DIM}skipped${NC}" >&2
    return 1
  fi
  printf "  validating... " >&2
  if "$validator" "$key"; then
    printf "%bok%b\n" "$GREEN" "$NC" >&2
    printf '%s' "$key"
    return 0
  else
    printf "  ${DIM}saving anyway — fix in .env if the feature misbehaves${NC}\n" >&2
    printf '%s' "$key"
    return 0
  fi
}

# --- Banner ----------------------------------------------------------------

echo ""
echo -e "${BOLD}🥑 Avocado Studio — first-time setup${NC}"
echo -e "${DIM}====================================${NC}"
echo ""
echo "Avocado Studio is powered by an LLM — it plans and applies edits to your"
echo "site from natural-language prompts. You'll need an API key to try it."
echo ""
echo -e "  ${DIM}→ Both Anthropic and OpenAI give new accounts free credits.${NC}"
echo -e "  ${DIM}→ Your key is stored only in .env on this machine. Never uploaded.${NC}"
echo ""

# --- Step 1: ensure .env exists --------------------------------------------

if (( DRY_RUN )); then
  # Always point at a fresh scratch copy of .env.example so the flow isn't
  # short-circuited by whatever's in the user's real .env. Cleaned up on
  # exit so nothing leaks.
  ENV_FILE="$(mktemp -t dev-setup-dryrun.XXXXXX)"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  trap 'rm -f "$ENV_FILE"' EXIT
  echo -e "${DIM}[dry-run]${NC} your real .env will not be touched; using scratch copy at $ENV_FILE"
  echo -e "${DIM}[dry-run]${NC} pnpm install will be skipped"
  echo ""
elif [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo -e "${GREEN}✓${NC} created .env from .env.example"
fi

# --- Step 2: check what's already configured -------------------------------

has_env_anthropic=$(grep -E '^ANTHROPIC_API_KEY=.+' "$ENV_FILE" 2>/dev/null || true)
has_env_openai=$(grep -E '^OPENAI_API_KEY=.+' "$ENV_FILE" 2>/dev/null || true)

if [[ -n "$has_env_anthropic" || -n "$has_env_openai" ]]; then
  echo -e "${GREEN}✓${NC} API key already configured in .env — skipping prompt."
  echo -e "  ${DIM}(edit .env directly to change it)${NC}"
else
  # Offer to reuse a key from the user's shell environment before asking
  # them to go create one.
  shell_anthropic="${ANTHROPIC_API_KEY:-}"
  shell_openai="${OPENAI_API_KEY:-}"

  reused=""
  if [[ -n "$shell_anthropic" ]]; then
    echo -e "Found ${BOLD}ANTHROPIC_API_KEY${NC} in your shell environment."
    read -rp "Use it? [Y/n]: " ans
    ans="${ans:-Y}"
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      printf "  validating... "
      if validate_anthropic_key "$shell_anthropic"; then
        printf "%bok%b\n" "$GREEN" "$NC"
        write_key "ANTHROPIC_API_KEY" "$shell_anthropic"
        reused="anthropic"
      else
        printf "%bfailed — will prompt for a new key%b\n" "$YELLOW" "$NC"
      fi
    fi
  fi

  if [[ -z "$reused" && -n "$shell_openai" ]]; then
    echo -e "Found ${BOLD}OPENAI_API_KEY${NC} in your shell environment."
    read -rp "Use it? [Y/n]: " ans
    ans="${ans:-Y}"
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      printf "  validating... "
      if validate_openai_key "$shell_openai"; then
        printf "%bok%b\n" "$GREEN" "$NC"
        write_key "OPENAI_API_KEY" "$shell_openai"
        reused="openai"
      else
        printf "%bfailed — will prompt for a new key%b\n" "$YELLOW" "$NC"
      fi
    fi
  fi

  if [[ -z "$reused" ]]; then
    echo ""
    echo "Choose a provider:"
    echo -e "  1) Anthropic (Claude) — ${GREEN}recommended, best-tested${NC}"
    echo "  2) OpenAI (GPT)"
    echo ""
    read -rp "Choose [1-2] (default: 1): " provider_choice
    provider_choice="${provider_choice:-1}"

    case "$provider_choice" in
      2)
        provider_label="OpenAI"
        provider_url="$OPENAI_KEYS_URL"
        provider_validator=validate_openai_key
        provider_env_var="OPENAI_API_KEY"
        ;;
      *)
        provider_label="Anthropic"
        provider_url="$ANTHROPIC_KEYS_URL"
        provider_validator=validate_anthropic_key
        provider_env_var="ANTHROPIC_API_KEY"
        ;;
    esac

    echo ""
    echo -e "Opening ${BOLD}${provider_url}${NC} in your browser."
    echo -e "${DIM}(if it doesn't open, copy the link above)${NC}"
    open_url "$provider_url"
    echo ""
    key=$(prompt_and_validate "$provider_label" "$provider_validator" "$provider_url")
    write_key "$provider_env_var" "$key"
    echo -e "${GREEN}✓${NC} saved ${provider_env_var} to .env"
  fi
fi

# --- Step 3: image generation (optional) -----------------------------------
# Image gen is independent of the planner LLM. If the user chose OpenAI it's
# already enabled (same key powers gpt-image-2 / gpt-image-1). If they chose Anthropic there
# is *no* image generation until they add a second key. Gemini is also the
# only provider for the conversational image-editor chat feature.

has_env_gemini=$(grep -E '^GOOGLE_GENAI_API_KEY=.+' "$ENV_FILE" 2>/dev/null || true)
openai_available=$(grep -E '^OPENAI_API_KEY=.+' "$ENV_FILE" 2>/dev/null || true)

echo ""
echo -e "${BOLD}🎨 Image generation${NC} ${DIM}(optional)${NC}"

if [[ -n "$has_env_gemini" ]]; then
  echo -e "${GREEN}✓${NC} Gemini already configured"
elif [[ -n "$openai_available" ]]; then
  echo -e "  ${DIM}→ Your OpenAI key already enables image gen (gpt-image-2 / gpt-image-1).${NC}"
  echo -e "  ${DIM}  Add Gemini too for conversational image editing (Gemini-only feature)?${NC}"
  read -rp "  Add Gemini? [y/N]: " img_ans
  if [[ "$img_ans" =~ ^[Yy]$ ]]; then
    open_url "https://aistudio.google.com/apikey"
    echo -e "  ${DIM}Opened https://aistudio.google.com/apikey${NC}"
    if gemini_key=$(prompt_optional_and_validate "Gemini" validate_gemini_key); then
      write_key "GOOGLE_GENAI_API_KEY" "$gemini_key"
      echo -e "${GREEN}✓${NC} saved GOOGLE_GENAI_API_KEY to .env"
    fi
  fi
else
  echo -e "  ${DIM}→ Anthropic does not generate images. Add a separate provider?${NC}"
  echo "    1) Gemini  (recommended — also powers conversational image editing)"
  echo "    2) OpenAI  (gpt-image-2 / gpt-image-1; separate key from your Anthropic planner)"
  echo "    3) Skip"
  read -rp "  Choose [1-3] (default: 3): " img_choice
  case "${img_choice:-3}" in
    1)
      open_url "https://aistudio.google.com/apikey"
      echo -e "  ${DIM}Opened https://aistudio.google.com/apikey${NC}"
      if gemini_key=$(prompt_optional_and_validate "Gemini" validate_gemini_key); then
        write_key "GOOGLE_GENAI_API_KEY" "$gemini_key"
        echo -e "${GREEN}✓${NC} saved GOOGLE_GENAI_API_KEY to .env"
      fi
      ;;
    2)
      open_url "$OPENAI_KEYS_URL"
      echo -e "  ${DIM}Opened $OPENAI_KEYS_URL${NC}"
      if oai_key=$(prompt_optional_and_validate "OpenAI" validate_openai_key); then
        write_key "OPENAI_API_KEY" "$oai_key"
        echo -e "${GREEN}✓${NC} saved OPENAI_API_KEY to .env (image generation only)"
      fi
      ;;
    *)
      echo -e "  ${DIM}skipped — the editor's Generate tab will be hidden${NC}"
      ;;
  esac
fi

# --- Step 4: Unsplash stock photos (optional) ------------------------------

has_env_unsplash=$(grep -E '^UNSPLASH_ACCESS_KEY=.+' "$ENV_FILE" 2>/dev/null || true)

echo ""
echo -e "${BOLD}📷 Unsplash stock photos${NC} ${DIM}(optional)${NC}"

if [[ -n "$has_env_unsplash" ]]; then
  echo -e "${GREEN}✓${NC} already configured"
else
  echo -e "  ${DIM}→ Free stock photos from the editor's asset picker.${NC}"
  echo -e "  ${DIM}  Create an \"application\" on Unsplash and copy its Access Key.${NC}"
  read -rp "  Configure Unsplash? [y/N]: " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    open_url "https://unsplash.com/oauth/applications"
    echo -e "  ${DIM}Opened https://unsplash.com/oauth/applications${NC}"
    if uns_key=$(prompt_optional_and_validate "Unsplash" validate_unsplash_key); then
      write_key "UNSPLASH_ACCESS_KEY" "$uns_key"
      echo -e "${GREEN}✓${NC} saved UNSPLASH_ACCESS_KEY to .env"
    fi
  fi
fi

# --- Step 5: Google Drive brand assets (optional) --------------------------
# No validator — Drive API requires both a folder ID and auth, and "is this
# API key valid" is a different question from "can it read that folder".
# We trust the user's copy-paste and let the editor surface real errors.

has_env_gdrive=$(grep -E '^GOOGLE_DRIVE_FOLDER_ID=.+' "$ENV_FILE" 2>/dev/null || true)

echo ""
echo -e "${BOLD}📂 Google Drive brand assets${NC} ${DIM}(optional)${NC}"

if [[ -n "$has_env_gdrive" ]]; then
  echo -e "${GREEN}✓${NC} already configured"
else
  echo -e "  ${DIM}→ Browse a shared Drive folder from the editor's asset picker.${NC}"
  echo -e "  ${DIM}  Needs: a publicly-shared folder + a Google API key with Drive API enabled.${NC}"
  read -rp "  Configure Google Drive? [y/N]: " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    open_url "https://console.cloud.google.com/apis/credentials"
    echo -e "  ${DIM}Opened Google Cloud Console — create an API key and enable the Drive API.${NC}"
    echo ""
    read -rp "  Drive folder ID (the part after /folders/ in the URL): " folder_id
    read -rp "  Google API key: " api_key
    if [[ -n "$folder_id" && -n "$api_key" ]]; then
      write_key "GOOGLE_DRIVE_FOLDER_ID" "$folder_id"
      write_key "GOOGLE_API_KEY" "$api_key"
      echo -e "${GREEN}✓${NC} saved GOOGLE_DRIVE_FOLDER_ID and GOOGLE_API_KEY to .env"
      echo -e "  ${DIM}(for private folders, use GOOGLE_SERVICE_ACCOUNT_KEY_JSON instead — see .env.example)${NC}"
    else
      echo -e "  ${DIM}skipped — need both folder ID and API key${NC}"
    fi
  fi
fi

# --- Step 6: install dependencies ------------------------------------------

if (( DRY_RUN )); then
  echo ""
  echo -e "${GREEN}${BOLD}Dry run complete.${NC}"
  echo -e "${DIM}No files were modified; pnpm install was skipped.${NC}"
  echo ""
  exit 0
fi

echo ""
echo "Installing dependencies..."
cd "$ROOT_DIR"
pnpm install

echo ""
echo -e "${GREEN}${BOLD}Setup complete.${NC}"
echo ""
echo "Next:"
echo -e "  ${BOLD}pnpm dev:start${NC}              start all services"
echo -e "  ${BOLD}open http://localhost:4100${NC}  open Avocado Studio"
echo ""
echo -e "${DIM}Using a CMS for assets?${NC}"
echo -e "${DIM}  • Contentful — set CONTENTFUL_SPACE_ID + CONTENTFUL_DELIVERY_TOKEN in .env${NC}"
echo -e "${DIM}  • Sanity / Strapi — configure per-site in the editor's Site Config drawer${NC}"
echo ""
