#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo ""
echo "AI Site Editor — first-time setup"
echo "================================="
echo ""

# Step 1: Copy .env
if [[ -f "$ENV_FILE" ]]; then
  echo -e "${YELLOW}.env already exists — skipping copy.${NC}"
else
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo -e "${GREEN}Created .env from .env.example${NC}"
fi

# Step 2: Prompt for API keys
has_anthropic=$(grep -E '^ANTHROPIC_API_KEY=.+' "$ENV_FILE" 2>/dev/null || true)
has_openai=$(grep -E '^OPENAI_API_KEY=.+' "$ENV_FILE" 2>/dev/null || true)

if [[ -n "$has_anthropic" || -n "$has_openai" ]]; then
  echo -e "${GREEN}API key already configured in .env${NC}"
else
  echo "Which LLM provider do you want to use?"
  echo ""
  echo -e "  1) Anthropic (Claude) — ${GREEN}recommended${NC}"
  echo "  2) OpenAI (GPT)"
  echo "  3) Both"
  echo "  4) Skip — demo mode (no LLM calls, pre-recorded plans)"
  echo ""
  read -rp "Choose [1-4] (default: 1): " provider_choice
  provider_choice="${provider_choice:-1}"

  case "$provider_choice" in
    1)
      echo ""
      echo "Get your API key at: https://console.anthropic.com/settings/keys"
      echo ""
      read -rp "Anthropic API key: " anthropic_key
      if [[ -n "$anthropic_key" ]]; then
        sed -i '' "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$anthropic_key|" "$ENV_FILE"
        echo -e "${GREEN}Saved ANTHROPIC_API_KEY${NC}"
      else
        echo -e "${YELLOW}Empty key — falling back to demo mode.${NC}"
      fi
      ;;
    2)
      echo ""
      echo "Get your API key at: https://platform.openai.com/api-keys"
      echo ""
      read -rp "OpenAI API key: " openai_key
      if [[ -n "$openai_key" ]]; then
        sed -i '' "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$openai_key|" "$ENV_FILE"
        echo -e "${GREEN}Saved OPENAI_API_KEY${NC}"
      else
        echo -e "${YELLOW}Empty key — falling back to demo mode.${NC}"
      fi
      ;;
    3)
      echo ""
      echo "Get your Anthropic key at: https://console.anthropic.com/settings/keys"
      read -rp "Anthropic API key: " anthropic_key
      if [[ -n "$anthropic_key" ]]; then
        sed -i '' "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$anthropic_key|" "$ENV_FILE"
        echo -e "${GREEN}Saved ANTHROPIC_API_KEY${NC}"
      fi
      echo ""
      echo "Get your OpenAI key at: https://platform.openai.com/api-keys"
      read -rp "OpenAI API key: " openai_key
      if [[ -n "$openai_key" ]]; then
        sed -i '' "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$openai_key|" "$ENV_FILE"
        echo -e "${GREEN}Saved OPENAI_API_KEY${NC}"
      fi
      if [[ -z "$anthropic_key" && -z "$openai_key" ]]; then
        echo -e "${YELLOW}No keys provided — falling back to demo mode.${NC}"
      fi
      ;;
    *)
      echo -e "${YELLOW}Demo mode — no API keys set.${NC}"
      ;;
  esac
fi

# Step 3: Install dependencies
echo ""
echo "Installing dependencies..."
cd "$ROOT_DIR"
pnpm install

echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "  pnpm dev:start     # start all services"
echo "  pnpm dev:status    # check health"
echo "  open http://localhost:4100  # open the editor"
echo ""
