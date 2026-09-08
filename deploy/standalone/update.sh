#!/usr/bin/env bash
# Pull the latest code and rebuild in place. The crm-data volume is untouched.
#   /opt/pipeline/crm/deploy/standalone/update.sh [branch]
set -euo pipefail
BRANCH="${1:-main}"
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
cd "$REPO"
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH"
git pull --quiet --ff-only origin "$BRANCH"
cd "$DIR"
docker compose up -d --build
docker compose ps
echo "Updated to $(git -C "$REPO" rev-parse --short HEAD) ($BRANCH)"
