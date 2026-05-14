#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="edit-ai-local-$(date +%Y%m%d-%H%M%S).tar.gz"
OUT_DIR="${1:-"$ROOT_DIR/output"}"
OUT_PATH="$OUT_DIR/$PACKAGE_NAME"

mkdir -p "$OUT_DIR"

tar \
  --exclude=".git" \
  --exclude=".github" \
  --exclude=".chief" \
  --exclude=".opencode" \
  --exclude=".env" \
  --exclude=".env.local" \
  --exclude="AGENTS.md" \
  --exclude="node_modules" \
  --exclude="dist" \
  --exclude="tests" \
  --exclude="*.test.ts" \
  --exclude="*.test.js" \
  --exclude="editai_note" \
  --exclude=".editai" \
  --exclude="test-results" \
  --exclude="output" \
  --exclude="*.log" \
  --exclude=".DS_Store" \
  -czf "$OUT_PATH" \
  -C "$(dirname "$ROOT_DIR")" \
  "$(basename "$ROOT_DIR")"

echo "$OUT_PATH"
