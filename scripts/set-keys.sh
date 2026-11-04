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

if [ "${1:-}" = "--supabase" ]; then
  # Public read-only site: the Mac publishes masked results to Supabase.
  ask SUPABASE_URL              "Supabase Project URL (https://xxxx.supabase.co)" no
  ask SUPABASE_ANON_KEY         "Supabase anon (public) key"                      no
  ask SUPABASE_SERVICE_ROLE_KEY "Supabase service_role key (stays on this Mac)"   yes
else
  ask LLM_API_KEY         "LLM API key (Gemini or Anthropic)" yes
  ask HUNTER_API_KEY      "Hunter.io API key"                 yes
  ask GMAIL_CLIENT_ID     "Google OAuth client ID"            no
  ask GMAIL_CLIENT_SECRET "Google OAuth client secret"        yes
  ask DEMO_INBOX_EMAIL    "Your Gmail address (the only inbox emails go to)" no
fi

echo
echo "Done. Saved to $(pwd)/$ENV"
