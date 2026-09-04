#!/usr/bin/env bash
# Pull the latest CRM and rebuild just the crm container in the shared stack.
# Usage on the VPS:  /root/crm/deploy/update.sh [branch]
set -euo pipefail
BRANCH="${1:-main}"
cd /root/crm
git fetch --quiet origin "$BRANCH"
git checkout --quiet "$BRANCH"
git pull --quiet --ff-only origin "$BRANCH"
cd /root/familyoffice
docker compose up -d --build crm
docker compose ps crm
echo "crm.gbxps.com updated to $(git -C /root/crm rev-parse --short HEAD) ($BRANCH)"
