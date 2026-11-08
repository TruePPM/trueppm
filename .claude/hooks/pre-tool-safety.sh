#!/usr/bin/env bash
# PreToolUse safety hook — blocks edits to lock files and migration files,
# warns on CI config and .env files.
#
# Receives the PreToolUse event on stdin (tool_input.file_path).

set -euo pipefail

# Real Edit/Write/NotebookEdit events nest the path under tool_input (file_path, or
# notebook_path for NotebookEdit); fall back to a top-level file_path.
INPUT_JSON=$(cat)
FILE_PATH=$(printf '%s' "$INPUT_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
t = d.get('tool_input') or {}
print(t.get('file_path') or t.get('notebook_path') or d.get('file_path') or '')
" 2>/dev/null || echo "")

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# Block: the skill-unlock marker (.claude/state/). pre-bash-deny.sh reads it as the user's
# authorization to run a few denied commands, so an agent must not create or alter it.
# Normalized and case-folded first (APFS is case-insensitive): `.Claude/State/x`,
# `.claude//state/x`, `.claude/./state/x` and `.claude/hooks/../state/x` are the same file.
if python3 -c "
import os, sys
p = os.path.normpath(sys.argv[1]).lower()
parts = p.split(os.sep)
sys.exit(0 if any(parts[i:i+2] == ['.claude', 'state'] for i in range(len(parts) - 1)) else 1)
" "$FILE_PATH"; then
  echo "BLOCKED: .claude/state/ holds the user's skill-unlock marker; agents must not write it." >&2
  exit 2
fi

BASENAME=$(basename "$FILE_PATH")

# Block: lock files
case "$BASENAME" in
  package-lock.json|yarn.lock|pnpm-lock.yaml|uv.lock|Pipfile.lock|poetry.lock|Cargo.lock|go.sum)
    echo "BLOCKED: Do not edit lock files directly. Use the package manager instead."
    exit 2
    ;;
esac

# Block: migration files (Django)
if [[ "$FILE_PATH" == */migrations/[0-9]*.py ]]; then
  echo "BLOCKED: Do not edit migration files directly. Use Django makemigrations."
  exit 2
fi

# Warn: CI config
case "$BASENAME" in
  .gitlab-ci.yml|.github/workflows/*|Dockerfile|docker-compose*.yml)
    echo "WARNING: Editing CI/infrastructure config. Double-check before proceeding."
    exit 0
    ;;
esac

# Warn: environment files
case "$BASENAME" in
  .env|.env.*|*.env)
    echo "WARNING: Editing environment file. Never commit secrets."
    exit 0
    ;;
esac

exit 0
