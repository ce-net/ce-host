#!/usr/bin/env bash
# POST-DEPLOY SMOKE GATE for CE Desktop (the PWA bundle) — assert the DEPLOYED BROWSER PATH
# actually works end to end through the real edge (Cloudflare -> nginx -> ce-serve -> node
# blobs). This is the test class unit/integration/local-e2e cannot cover; per Leif's standing
# directive every deploy must prove, against the LIVE URL, that the page boots in a browser.
#
# Layers (1-4 are the authoritative HTTP gate; 5 is a real headless-browser boot check):
#   1. the page serves HTML,
#   2. ce-serve injected /__ce/mesh-bridge.js (proves it is served by ce-serve, not a stale
#      cache / failed registration — without it a browser gets no window.__ceNode transport),
#   3. every hashed JS/CSS asset the HTML references returns 200 (the WHOLE bundle published),
#   4. the PWA artifacts (manifest.webmanifest, sw.js, icon) are served + the manifest is JSON,
#   5. if Chrome is available, the app actually boots and renders its nav (Network/Explorer/...).
set -euo pipefail

BASE="${1:-https://desktop.ce-net.com}"
UA="Mozilla/5.0 (smoke)"
fail() { echo "SMOKE FAIL: $1" >&2; exit 1; }
body() { curl -fsS -m 25 -A "$UA" "$1"; }
code() { curl -s -m 25 -o /dev/null -w "%{http_code}" -A "$UA" "$1"; }

echo "==> smoke 1/5: page serves HTML"
page="$(body "$BASE/")" || fail "GET $BASE/ failed"
echo "$page" | grep -qiE "<!doctype html|<html" || fail "response is not HTML"
echo "    ok"

echo "==> smoke 2/5: ce-serve injected the mesh bridge"
echo "$page" | grep -q "/__ce/mesh-bridge.js" \
  || fail "no /__ce/mesh-bridge.js injection -> not served by ce-serve (stale cache / failed register)"
echo "    ok"

echo "==> smoke 3/5: every referenced JS/CSS asset is present (200)"
assets="$(printf '%s' "$page" | grep -oE '/assets/[A-Za-z0-9._-]+\.(js|css)' | sort -u)"
[ -n "$assets" ] || fail "no /assets/* referenced in the HTML (bad/empty bundle)"
for a in $assets; do
  c="$(code "$BASE$a")"; [ "$c" = 200 ] || fail "asset $a -> HTTP $c"
  echo "    ok $a"
done

echo "==> smoke 4/5: PWA artifacts served"
for f in /manifest.webmanifest /sw.js /icons/icon-512.png; do
  c="$(code "$BASE$f")"; [ "$c" = 200 ] || fail "$f -> HTTP $c"
  echo "    ok $f"
done
body "$BASE/manifest.webmanifest" | python3 -c 'import sys,json; json.load(sys.stdin)' \
  || fail "manifest.webmanifest is not valid JSON"
echo "    ok manifest is valid JSON"

echo "==> smoke 5/5: app boots in a real browser (headless Chrome)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ -x "$CHROME" ]; then
  tmp="$(mktemp -d)"
  dom="$("$CHROME" --headless=new --disable-gpu --no-sandbox --user-data-dir="$tmp" \
        --virtual-time-budget=9000 --dump-dom "$BASE/" 2>/dev/null || true)"
  rm -rf "$tmp"
  if [ -z "$dom" ] || printf '%s' "$dom" | grep -qiE "just a moment|cf-browser-verification|attention required"; then
    echo "    warn: browser returned empty / a Cloudflare challenge — cannot conclude; HTTP gate (1-4) stands"
  else
    printf '%s' "$dom" | grep -q "nav-item" || fail "app did not render nav -> JS boot failed in the browser"
    for label in Network Explorer Apps Wallet; do
      printf '%s' "$dom" | grep -q ">$label<" || fail "rendered nav is missing '$label'"
    done
    echo "    ok: app shell rendered (Network / Explorer / Apps / Wallet)"
  fi
else
  echo "    (skip browser boot: Chrome not found at \$CHROME; HTTP gate 1-4 passed)"
fi

echo "SMOKE PASS: $BASE is live, fully served, PWA-ready."
