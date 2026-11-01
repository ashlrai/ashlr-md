#!/usr/bin/env bash
# Run workspace checks and changed Node tests relative to origin/main.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
start=$SECONDS
status=0
log=$(mktemp) || exit 1
files=$(mktemp) || { rm -f "$log"; exit 1; }
trap 'rm -f "$log" "$files"' EXIT

step() {
  local name=$1
  shift
  if "$@" >"$log" 2>&1; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s\n' "$name"
    cat "$log"
    status=1
  fi
}

step typecheck bun run typecheck
step lint bun run lint

changed_node_tests() {
  # Include committed, staged, unstaged, and untracked changes. NUL delimiters
  # preserve paths containing whitespace and avoid executing deleted tests.
  git diff --name-only -z origin/main -- || return 1
  git ls-files --others --exclude-standard -z || return 1
}
run_node_tests() {
  changed_node_tests >"$files" || return 1
  local file
  local tests=()
  while IFS= read -r -d '' file; do
    case "$file" in
      scripts/fast-check.test.mjs) ;; # This test invokes fast-check itself.
      *.test.mjs|*.test.cjs|*.test.js) [[ -f "$file" ]] && tests+=("./$file") ;;
    esac
  done < "$files"
  if ((${#tests[@]})); then
    node --test "${tests[@]}"
  fi
}
step 'node tests' run_node_tests
printf 'Total: %s seconds\n' "$((SECONDS - start))"
exit "$status"
