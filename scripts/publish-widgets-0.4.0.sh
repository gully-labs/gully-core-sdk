#!/usr/bin/env bash
# @gullylabs/core-widgets 0.4.0 to npm (prepared 2026-11-12; the owner runs it, npm 2FA). Nothing here runs by itself.
#
#   Windows: open Git Bash (forward-slash paths), then
#     cd /c/Users/Admin/Desktop/PROJECTS/gully-core-sdk && bash scripts/publish-widgets-0.4.0.sh --dry-run
#     cd /c/Users/Admin/Desktop/PROJECTS/gully-core-sdk && bash scripts/publish-widgets-0.4.0.sh
#
# What it publishes: @gullylabs/core-widgets 0.4.0 from this repo (packages/widgets): the buy alert widget (`<gully-buys>`,
# `BuysFeed`, the `buys.js` bundle) on top of 0.3.0. One package; a version already on npm is skipped, so a re-run after a
# 2FA timeout is safe. The hosted https://gullycore.xyz/buys.js and the Gully Core app do not depend on this publish: they
# carry the same build already. After the publish, docs.gullycore.xyz/buy-alerts/ prints the install line by itself at its
# next build (the {{npm}} macro reads the registry).
#
# The checkout must be CLEAN and at origin/main with the 0.4.0 PR merged (checked below). Auth: npm login of this machine
# (`npm whoami`), or NPM_TOKEN in the environment (written to a temp npmrc, removed on exit, never echoed). 2FA: the
# one-time code from the authenticator app is read at the prompt and passed as --otp (npm's browser flow timed out on
# 2026-11-12); it is typed in this terminal and never written anywhere. Enter alone falls back to the browser approval.
set -euo pipefail

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/packages/widgets"
NAME="@gullylabs/core-widgets"
WANT="0.4.0"

say() { printf '\n== %s\n' "$*"; }

NPMRC_TMP=""
cleanup() { if [ -n "$NPMRC_TMP" ]; then rm -f "$NPMRC_TMP"; fi; }
trap cleanup EXIT
if [ -n "${NPM_TOKEN:-}" ]; then
  NPMRC_TMP="$(mktemp)"
  printf '//registry.npmjs.org/:_authToken=%s\nregistry=https://registry.npmjs.org/\n' "$NPM_TOKEN" > "$NPMRC_TMP"
  export NPM_CONFIG_USERCONFIG="$NPMRC_TMP"
fi

say "checkout"
[ -d "$ROOT/.git" ] || [ -f "$ROOT/.git" ] || { echo "refusing: $ROOT is not a git checkout" >&2; exit 1; }
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then git -C "$ROOT" status --short >&2; echo "refusing: $ROOT is not clean" >&2; exit 1; fi
git -C "$ROOT" fetch -q origin
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse origin/main)" ] || { echo "refusing: not at origin/main (git checkout main && git pull)" >&2; exit 1; }
HAVE="$(cd "$ROOT" && node -p "require('./packages/widgets/package.json').version")"  # relative: Windows Node can't resolve /c/... paths
[ "$HAVE" = "$WANT" ] || { echo "refusing: packages/widgets is $HAVE, expected $WANT (merge the 0.4.0 PR first)" >&2; exit 1; }
echo "ok  $ROOT @ $(git -C "$ROOT" rev-parse --short HEAD), $NAME $HAVE"

if npm view "$NAME@$WANT" version >/dev/null 2>&1; then echo "already on npm: $NAME@$WANT (nothing to do)"; exit 0; fi

say "build + tests (pnpm workspace: the SDK first, then the widgets)"
(cd "$ROOT" && pnpm install --frozen-lockfile --ignore-scripts)
(cd "$ROOT" && pnpm --filter @gullylabs/core-sdk run build && pnpm --filter @gullylabs/core-widgets run build && pnpm --filter @gullylabs/core-widgets run test)
for f in dist/index.js dist/index.d.ts dist/embed.js dist/gullycore-embed.js dist/buys.js dist/buys.mjs dist/styles.css; do
  [ -s "$PKG/$f" ] || { echo "refusing: $PKG/$f missing after the build" >&2; exit 1; }
done
grep -q '"gully-buys"' "$PKG/dist/buys.js" || { echo "refusing: dist/buys.js does not carry <gully-buys>" >&2; exit 1; }

say "tarball"
(cd "$PKG" && pnpm pack --pack-destination "$ROOT/.pack" >/dev/null && ls -la "$ROOT/.pack"/gullylabs-core-widgets-*.tgz)
TGZ="$(ls "$ROOT/.pack"/gullylabs-core-widgets-"$WANT".tgz)"
tar -tzf "$TGZ" | grep -q 'package/dist/buys.js' || { echo "refusing: the tarball lacks dist/buys.js" >&2; exit 1; }
# workspace:* must have become a real range in the packed manifest
tar -xzOf "$TGZ" package/package.json | grep -q '"@gullylabs/core-sdk": "workspace' && { echo "refusing: workspace range left in the tarball" >&2; exit 1; }

if [ "$DRY" = 1 ]; then
  say "dry run"
  (cd "$PKG" && npm publish "$TGZ" --access public --dry-run)
  rm -rf "$ROOT/.pack"
  exit 0
fi

WHO="$(npm whoami --registry https://registry.npmjs.org/ 2>/dev/null || true)"
[ -n "$WHO" ] || { echo "refusing: not logged in to npm (npm login, or set NPM_TOKEN)" >&2; exit 1; }
echo "npm user: $WHO"
read -r -p "Publish $NAME@$WANT to npm? Type PUBLISH: " ans
[ "$ans" = "PUBLISH" ] || { echo "stopped"; rm -rf "$ROOT/.pack"; exit 1; }
otp=""
read -r -p "authenticator code for $NAME@$WANT (6 digits; Enter = browser approval): " otp
case "$otp" in ''|[0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo "not a 6-digit code: stopped" >&2; rm -rf "$ROOT/.pack"; exit 1 ;; esac
(cd "$PKG" && npm publish "$TGZ" --access public ${otp:+--otp="$otp"})
rm -rf "$ROOT/.pack"
for i in 1 2 3 4 5 6; do
  if npm view "$NAME@$WANT" version >/dev/null 2>&1; then echo "on npm: $NAME@$WANT"; break; fi
  sleep 10
done

say "done"
echo "tag: git -C $ROOT tag -a widgets-v$WANT -m 'core-widgets $WANT' && git -C $ROOT push origin widgets-v$WANT"
echo "docs: the next gully-ops site deploy prints the 0.4.0 install line on docs.gullycore.xyz/buy-alerts/ (npm gate)"
