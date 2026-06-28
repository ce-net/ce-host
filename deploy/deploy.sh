#!/usr/bin/env bash
# Deploy CE Desktop (the web bundle) as a served, content-addressed app on ce-net.
#
#   build dist/  ->  rsync to the relay  ->  ce-publish bundle (blobs + ce-hub register)  ->  smoke
#
# The bundle is published ON THE RELAY against its local node (CE_NODE_URL=127.0.0.1:8844) so
# ce-serve fetches the blobs from the same node it runs beside. ce-serve resolves
# desktop.ce-net.com -> bundle via ce-hub; the nginx *.ce-net.com regex + the Cloudflare
# wildcard already route the host, so no nginx/DNS change is needed.
#
# Prereq: the relay key in the agent or at ~/.ssh/id_ed25519 (ssh-add ~/.ssh/id_ed25519).
#
#   bash deploy/deploy.sh            # build + publish + smoke
#   bash deploy/deploy.sh smoke      # smoke only (against the live URL)
set -euo pipefail

RELAY="root@178.105.145.170"
KEY="${CE_SSH_KEY_PATH:-$HOME/.ssh/id_ed25519}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=12 -i "$KEY")
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOSTN="desktop.ce-net.com"
APPID="ce-desktop"
REMOTE="/opt/ce-build/ce-desktop-bundle"

smoke() { bash "$HERE/deploy/smoke.sh" "https://$HOSTN"; }

publish() {
  echo "==> build the web bundle"
  ( cd "$HERE" && npm run build )
  [ -f "$HERE/dist/index.html" ] || { echo "deploy: dist/index.html not built"; exit 1; }

  echo "==> sync bundle to the relay ($REMOTE)"
  "${SSH[@]}" "$RELAY" "mkdir -p $REMOTE"
  rsync -az --delete -e "ssh -o BatchMode=yes -i $KEY" "$HERE/dist/" "$RELAY:$REMOTE/"

  echo "==> publish via ce-publish on the relay (blobs -> node, host -> ce-hub)"
  "${SSH[@]}" "$RELAY" \
    "CE_NODE_URL=http://127.0.0.1:8844 CE_HUB_URL=http://127.0.0.1:8970 ce-publish bundle $REMOTE $HOSTN $APPID"

  echo "==> ce-serve now serves https://$HOSTN/"
}

case "${1:-all}" in
  smoke) smoke ;;
  all)   publish; smoke ;;
  *)     echo "usage: deploy.sh [all|smoke]"; exit 1 ;;
esac
echo "==> done: https://$HOSTN/"
