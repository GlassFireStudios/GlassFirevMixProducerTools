#!/usr/bin/env bash
# Deploy the committed HEAD to the vMix Tools box.
#
#   scripts/deploy.sh            refuses if anything is live (show-mode guard)
#   FORCE=1 scripts/deploy.sh    deploy anyway
#
# "Live" = any MediaMTX path online, or any vMix the hub knows is recording or
# streaming. A deploy restarts the hub: connected feeds survive, but new
# connections are refused for ~1-2s and in-memory metrics history resets.
set -euo pipefail

HOST="${DEPLOY_HOST:-ec2-user@13.216.6.158}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/gf.pem}"
APP=/opt/glassfire-tools
SSH=(ssh -i "$KEY" -o LogLevel=ERROR "$HOST")

cd "$(dirname "$0")/.."
npm test --silent

# One number from the box: live MediaMTX paths + vMix machines recording/streaming.
live=$("${SSH[@]}" "cd $APP && if [ -f scripts/live-count.mjs ]; then node scripts/live-count.mjs; else curl -s http://127.0.0.1:9997/v3/paths/list | grep -o '\"ready\":true' | wc -l; fi")

if [ "${live:-0}" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Refusing to deploy: $live live feed(s)/recording or streaming vMix right now. Use FORCE=1 to override." >&2
  exit 2
fi

TMP="$(mktemp -d)/gftools.tgz"
git archive --format=tar.gz -o "$TMP" HEAD
scp -i "$KEY" -o LogLevel=ERROR "$TMP" "$HOST:/tmp/gftools.tgz"
"${SSH[@]}" "set -e; cd $APP; tar -xzf /tmp/gftools.tgz --exclude=config.json -C $APP; npm ci --omit=dev >/dev/null 2>&1; sudo systemctl restart glassfire-tools; sleep 2; systemctl is-active glassfire-tools; grep -o '\"version\": \"[^\"]*\"' package.json"
