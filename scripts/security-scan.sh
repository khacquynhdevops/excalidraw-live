#!/bin/sh
# Security checks in Docker: secrets in the whole git history (gitleaks),
# SAST on the source (Semgrep), high or worse advisories in production
# dependencies (npm audit). Exits non-zero if any check fails.
cd "$(dirname "$0")/.." || exit 1
repo=$(pwd)
failed=

step() {
  name=$1; shift
  echo "== $name"
  if "$@"; then echo "== $name: pass"; else echo "== $name: FAIL"; failed="$failed $name"; fi
}

step secrets docker run --rm -v "$repo:/repo:ro" ghcr.io/gitleaks/gitleaks:v8.30.1 \
  git /repo --log-opts=--all --redact --no-banner

# The committed runtime bundle is built from this source and third-party
# packages, so it is left to the dependency check.
step sast docker run --rm -v "$repo:/src:ro" -w /src semgrep/semgrep:1.184.0 \
  semgrep scan --metrics=off --error --severity WARNING --severity ERROR \
  --config p/default --config p/typescript --config p/nodejs \
  --exclude skills/setup-excalidraw-live-multiagent/runtime --exclude node_modules --exclude dist

step dependencies docker run --rm -v "$repo:/app:ro" -w /app node:22-alpine \
  npm audit --omit=dev --audit-level=high

[ -z "$failed" ] && echo "all checks passed" || { echo "failed:$failed"; exit 1; }
