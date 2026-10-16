#!/usr/bin/env bash
# Push only the named scorers to Braintrust. Anything not named is not uploaded, so it gets no new version.
#   npm run push:scorers -- --name token_compliance
#   npm run push:scorers -- --name a11y_hygiene --name token_compliance
#   npm run push:scorers -- --all
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
[ -n "${BRAINTRUST_PROJECT_ID:-}" ] || { echo 'Missing BRAINTRUST_PROJECT_ID' >&2; exit 1; }

names=()
all=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) [ $# -ge 2 ] || { echo '--name needs a value' >&2; exit 1; }; names+=("$2"); shift 2 ;;
    --name=*) names+=("${1#*=}"); shift ;;
    --all) all=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ "$all" -eq 0 ] && [ "${#names[@]}" -eq 0 ]; then
  echo 'Name the scorer(s) to push: npm run push:scorers -- --name token_compliance (or --all)' >&2
  exit 1
fi

# push.ts reads PUSH_SCORERS (comma-separated) and registers only those; unset means register all.
if [ "$all" -eq 1 ]; then unset PUSH_SCORERS; else export PUSH_SCORERS="$(IFS=,; echo "${names[*]}")"; fi
exec bt functions push scorers/push.ts --if-exists replace
