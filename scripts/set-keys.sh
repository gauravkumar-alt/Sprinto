#!/bin/bash
# Prompts for API keys (secrets are hidden while typing) and writes them into .env.local.
# Press Enter on any prompt to keep the current value.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV=.env.local
touch "$ENV"
chmod 600 "$ENV"

set_var() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${name}=" "$ENV" > "$tmp" || true
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  mv "$tmp" "$ENV"
  chmod 600 "$ENV"
}

ask() {
  local name="$1" label="$2" secret="$3" value
  if [ "$secret" = "yes" ]; then
    read -r -s -p "$label (hidden, Enter to skip): " value; echo
  else
    read -r -p "$label (Enter to skip): " value
  fi
  value="$(printf '%s' "$value" | tr -d '[:space:]')"
  if [ -n "$value" ]; then set_var "$name" "$value"; echo "  ✓ $name saved"; else echo "  – $name unchanged"; fi
}

ask LLM_API_KEY         "Anthropic API key"                 yes
ask HUNTER_API_KEY      "Hunter.io API key"                 yes
ask GMAIL_CLIENT_ID     "Google OAuth client ID"            no
ask GMAIL_CLIENT_SECRET "Google OAuth client secret"        yes
ask DEMO_INBOX_EMAIL    "Your Gmail address (the only inbox emails go to)" no

echo
echo "Done. Saved to $(pwd)/$ENV"
