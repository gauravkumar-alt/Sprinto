#!/bin/bash
# Waits until the main Gemini model has quota again, then re-runs the given companies through the
# local agent (which republishes the public site when the batch finishes).
# Usage: bash scripts/rerun-when-ready.sh "Rallly | rallly.co" "Twenty | twenty.com" ...
# Needs the app running on http://127.0.0.1:3123. Stop with Ctrl-C.
set -u
cd "$(dirname "$0")/.."
KEY=$(grep '^LLM_API_KEY=' .env.local | cut -d= -f2-)
MODEL=$(grep '^LLM_MODEL=' .env.local | cut -d= -f2-)
MODEL=${MODEL:-gemini-3.6-flash}
DOMAINS=$(printf '%s\n' "$@")

until [ "$(curl -s -o /dev/null -m 30 -w '%{http_code}' -X POST "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent" \
  -H "x-goog-api-key: ${KEY}" -H 'content-type: application/json' -d '{"contents":[{"parts":[{"text":"Say ok"}]}]}')" = "200" ]; do
  echo "$(date '+%H:%M') ${MODEL} not available yet — checking again in 30 min"
  sleep 1800
done

echo "$(date '+%H:%M') ${MODEL} is back — re-running:"
echo "$DOMAINS"
BODY=$(python3 -c 'import json,sys; print(json.dumps({"domains": sys.stdin.read()}))' <<<"$DOMAINS")
curl -s -X POST http://127.0.0.1:3123/api/batches -H 'content-type: application/json' -H 'origin: http://127.0.0.1:3123' -d "$BODY"
echo
echo "Started. Results appear on the dashboard and the public site when the batch finishes."
