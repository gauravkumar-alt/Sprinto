#!/bin/bash
# Publish the latest results to Supabase (works even when npm isn't on your PATH).
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node-v22.23.4-darwin-arm64/bin:$PATH"
npm run snapshot
