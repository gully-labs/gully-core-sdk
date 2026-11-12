#!/usr/bin/env bash
# The 0.3.1 npm batch (prepared 2026-11-12; the owner runs it, npm 2FA). Nothing here runs by itself.
#
#   Windows: open Git Bash (forward-slash paths), then
#     cd /c/Users/Admin/Desktop/PROJECTS/gully-core-sdk && bash scripts/publish-batch-0.3.1.sh --dry-run
#     cd /c/Users/Admin/Desktop/PROJECTS/gully-core-sdk && bash scripts/publish-batch-0.3.1.sh
#   After the five gully-core-sdk packages are on npm (2026-11-12 06:40 UTC), the rest only:
#     cd /c/Users/Admin/Desktop/PROJECTS/gully-core-sdk && bash scripts/publish-batch-0.3.1.sh --skip-core
#
# What it publishes, in order (a version already on npm is skipped, so a re-run after a 2FA timeout is safe):
#   1. gully-labs/gully-core-sdk  (this repo, scripts/publish.sh: build, tests, sync check, tarball smoke incl. a
#      scaffolded app that installs and builds, then one npm publish per package)
#        @gullylabs/core-sdk         0.3.1   metadata fix (no write-cjs-marker.mjs in the scripts)
#        @gullylabs/core-connect     0.2.0   first publish (the app template depends on it)
#        @gullylabs/core-widgets     0.3.0   first publish (the app template depends on it)
#        @gullylabs/create-core-app  0.3.1   app links, --chain display names, help text; installs from npm
#        @gullylabs/core-cli         0.3.1   `core-cli` bin, so `npx @gullylabs/core-cli` works
#   2. gully-labs/gullychain-sdk   @gullylabs/chain 0.3.1   .d.ts fix (TS2693 with skipLibCheck off)
#   3. gully-labs/gull-pay         @gullylabs/pay   0.1.1   .d.ts fix (no viem/_types import)
#
# Each repo must be a CLEAN checkout of origin/main with the 0.3.1 PRs merged (checked below). Auth: npm login of
# this machine (`npm whoami`), or NPM_TOKEN in the environment (written to a temp npmrc, removed on exit, never echoed).
set -euo pipefail

DRY=0
SKIP_CORE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --skip-core) SKIP_CORE=1 ;;  # the five gully-core-sdk packages are on npm already: only chain + pay
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

PROJECTS="${GULLY_PROJECTS:-/c/Users/Admin/Desktop/PROJECTS}"
CORE="$PROJECTS/gully-core-sdk"
CHAIN="$PROJECTS/gullychain-sdk"
PAY="$PROJECTS/gull-pay"

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"  # the chain d.ts build OOMs at the 2 GB default

say() { printf '\n== %s\n' "$*"; }

NPMRC_TMP=""
cleanup() { if [ -n "$NPMRC_TMP" ]; then rm -f "$NPMRC_TMP"; fi; }
trap cleanup EXIT
if [ -n "${NPM_TOKEN:-}" ]; then
  NPMRC_TMP="$(mktemp)"
  printf '//registry.npmjs.org/:_authToken=%s\nregistry=https://registry.npmjs.org/\n' "$NPM_TOKEN" > "$NPMRC_TMP"
  export NPM_CONFIG_USERCONFIG="$NPMRC_TMP"
fi

clean_main() { # <dir> <expected package.json path> <expected version>
  local dir="$1" pj="$2" want="$3" have
  [ -d "$dir/.git" ] || [ -f "$dir/.git" ] || { echo "refusing: $dir is not a git checkout" >&2; exit 1; }
  if [ -n "$(git -C "$dir" status --porcelain)" ]; then git -C "$dir" status --short >&2; echo "refusing: $dir is not clean" >&2; exit 1; fi
  git -C "$dir" fetch -q origin
  [ "$(git -C "$dir" rev-parse HEAD)" = "$(git -C "$dir" rev-parse origin/main)" ] || { echo "refusing: $dir is not at origin/main (git -C $dir checkout main && git -C $dir pull)" >&2; exit 1; }
  have="$(cd "$dir" && node -p "require('./$pj').version")"  # relative: Windows Node can't resolve /c/... paths
  [ "$have" = "$want" ] || { echo "refusing: $dir/$pj is $have, expected $want (merge the 0.3.1 PR first)" >&2; exit 1; }
  echo "ok  $dir @ $(git -C "$dir" rev-parse --short HEAD), $pj $have"
}

say "checkouts"
clean_main "$CORE" packages/sdk/package.json 0.3.1
clean_main "$CHAIN" package.json 0.3.1
clean_main "$PAY" packages/pay-sdk/package.json 0.1.1

if [ "$DRY" = 0 ]; then
  WHO="$(npm whoami --registry https://registry.npmjs.org/ 2>/dev/null || true)"
  [ -n "$WHO" ] || { echo "refusing: not logged in to npm (npm login, or set NPM_TOKEN)" >&2; exit 1; }
  echo "npm user: $WHO"
  read -r -p "Publish the 0.3.1 batch (7 packages, 3 repos) to npm? Type PUBLISH: " ans
  [ "$ans" = "PUBLISH" ] || { echo "stopped"; exit 1; }
fi

publish_dir() { # <package dir> : build, test, consumer d.ts check, then npm publish (skipped when on npm)
  local d="$1" name version
  name="$(cd "$d" && node -p "require('./package.json').name")"
  version="$(cd "$d" && node -p "require('./package.json').version")"
  say "$name@$version  ($d)"
  if npm view "$name@$version" version >/dev/null 2>&1; then echo "already on npm: skipped"; return 0; fi
  (cd "$d" && { if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; else npm install --ignore-scripts --no-audit --no-fund --no-package-lock; fi; } && npm run build && npm test && node scripts/check-dts.mjs)
  if [ "$DRY" = 1 ]; then
    (cd "$d" && npm publish --access public --dry-run)
  else
    (cd "$d" && npm publish --access public)
    for i in 1 2 3 4 5 6; do
      if npm view "$name@$version" version >/dev/null 2>&1; then echo "on npm: $name@$version"; return 0; fi
      sleep 10
    done
    echo "published, but npm view does not show $name@$version yet" >&2
  fi
}

say "1/3 gully-core-sdk (5 packages)"
if [ "$SKIP_CORE" = 1 ]; then echo "skipped (--skip-core)"
elif [ "$DRY" = 1 ]; then (cd "$CORE" && bash scripts/publish.sh --dry-run); else (cd "$CORE" && bash scripts/publish.sh --yes); fi

say "2/3 gullychain-sdk"
publish_dir "$CHAIN"

say "3/3 gull-pay"
publish_dir "$PAY/packages/pay-sdk"

say "done"
if [ "$DRY" = 0 ]; then
  echo "tags: git -C $CORE tag -a v0.3.1 -m release && git -C $CORE push origin v0.3.1"
  echo "      git -C $CHAIN tag -a v0.3.1 -m release && git -C $CHAIN push origin v0.3.1"
  echo "      (gull-pay: no tag; its pay-sdk-v* tag workflow would publish again and is skipped by npm as a duplicate)"
fi
