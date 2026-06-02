#!/usr/bin/env bash
# PostToolUse hook: auto-format + auto-fix lint on .ts edits.
# Never blocks the workflow — always exits 0. Any remaining (non-auto-fixable)
# eslint errors are surfaced back to Claude via additionalContext so Claude can fix them.

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

# Only act on TypeScript files.
case "$file" in
  *.ts) ;;
  *) exit 0 ;;
esac

# Skip if file no longer exists (e.g. deleted/renamed).
[ -f "$file" ] || exit 0

# Resolve the project's locally-installed binaries by walking up to find
# node_modules/.bin. Calling these paths directly guarantees the project's
# pinned versions (eslint v8 + .eslintrc.json) and never falls back to a
# network/npx-cache version with an incompatible config format.
bin_dir=""
dir=$(cd "$(dirname "$file")" && pwd)
while [ "$dir" != "/" ]; do
  if [ -x "$dir/node_modules/.bin/eslint" ]; then
    bin_dir="$dir/node_modules/.bin"
    break
  fi
  dir=$(dirname "$dir")
done

# Deps not installed yet → skip silently. Never block the workflow.
[ -n "$bin_dir" ] || exit 0

# Auto-fix formatting + fixable lint issues. Ignore their exit codes.
"$bin_dir/prettier" --write "$file" >/dev/null 2>&1
"$bin_dir/eslint" --fix "$file" >/dev/null 2>&1

# Re-run eslint to capture whatever could NOT be auto-fixed.
lint_output=$("$bin_dir/eslint" "$file" 2>&1)
lint_status=$?

if [ $lint_status -ne 0 ]; then
  # Feed remaining errors to Claude without blocking the workflow.
  msg=$(printf 'eslint reported unresolved problems in %s after auto-fix. Please fix them:\n\n%s' "$file" "$lint_output")
  jq -n --arg ctx "$msg" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
else
  echo "formatted+linted: $file"
fi

exit 0
