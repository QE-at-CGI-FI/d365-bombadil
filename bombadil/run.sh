#!/usr/bin/env bash
# Runs the default-properties-only Bombadil spec against one of the D365
# environments configured under .env/. Usage:
#
#   ./bombadil/run.sh rel [bombadil options...]
#   ./bombadil/run.sh build [bombadil options...]
#
# Extra arguments are passed through to `bombadil browser test`, e.g.:
#
#   ./bombadil/run.sh rel --headless --time-limit=5m --exit-on-violation
set -euo pipefail

env_name="${1:-rel}"
shift || true

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/.env/.env.$env_name"

if [[ ! -f "$env_file" ]]; then
  echo "Unknown environment '$env_name' (expected $env_file to exist)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

time_limit_args=(--time-limit=2m)
if [[ "${*:-}" == *--time-limit* ]]; then
  time_limit_args=()
fi

exec bombadil browser test \
  --output-path "$repo_root/bombadil-output/$env_name" \
  ${time_limit_args[@]+"${time_limit_args[@]}"} \
  ${@+"$@"} \
  "$URL" \
  "$repo_root/bombadil/specification.ts"
