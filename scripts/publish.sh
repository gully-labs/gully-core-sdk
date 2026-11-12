#!/usr/bin/env bash
# Publish @gullylabs/core-sdk, @gullylabs/core-connect, @gullylabs/core-widgets, @gullylabs/create-core-app and
# @gullylabs/core-cli to npm, in that order (the app template installs connect and widgets, so they go before it).
# Windows: run from Git Bash (forward-slash paths), e.g.  cd /c/Users/<you>/Desktop/PROJECTS/gully-core-sdk && bash scripts/publish.sh
#
#   bash scripts/publish.sh --dry-run     everything up to and including `npm publish --dry-run`
#   bash scripts/publish.sh               the same, then the real publish (asks before it starts)
#   bash scripts/publish.sh --yes         no question (CI)
#
# Runs from a clean checkout only: no uncommitted or untracked files, HEAD at a commit that is on origin.
# Auth: NPM_TOKEN from the environment (an npm automation token for the @gullylabs scope) when set; otherwise
# the npm login of this machine (`npm whoami`). The token is written to a temporary npmrc that is removed on
# exit; it is never echoed. Provenance: on GitHub Actions (OIDC available) `--provenance` is added.
#
# What is published is the tarball `pnpm pack` made and the smoke test installed: workspace ranges are
# rewritten to real versions by pnpm, and npm publishes that exact file. A version already on npm is skipped.
set -euo pipefail

DRY=0; YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes) YES=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n== %s\n' "$*"; }

say "clean checkout"
if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  echo "refusing: the working tree is not clean (commit or stash first)" >&2
  exit 1
fi
git fetch -q origin
if ! git branch -r --contains HEAD | grep -q 'origin/'; then
  echo "refusing: HEAD $(git rev-parse --short HEAD) is not on origin (push it first)" >&2
  exit 1
fi
echo "HEAD $(git rev-parse --short HEAD) $(git log -1 --format=%s)"

NPMRC_TMP=""
cleanup() { if [ -n "$NPMRC_TMP" ]; then rm -f "$NPMRC_TMP"; fi; }
trap cleanup EXIT
if [ -n "${NPM_TOKEN:-}" ]; then
  NPMRC_TMP="$(mktemp)"
  printf '//registry.npmjs.org/:_authToken=%s\nregistry=https://registry.npmjs.org/\n' "$NPM_TOKEN" > "$NPMRC_TMP"
  export NPM_CONFIG_USERCONFIG="$NPMRC_TMP"
  echo "auth: NPM_TOKEN from the environment"
else
  echo "auth: this machine's npm login"
fi
if [ "$DRY" = 0 ]; then
  WHO="$(npm whoami --registry https://registry.npmjs.org/ 2>/dev/null || true)"
  if [ -z "$WHO" ]; then echo "refusing: not logged in to npm (set NPM_TOKEN or run npm login)" >&2; exit 1; fi
  echo "npm user: $WHO"
fi

say "install, build, typecheck, test"
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test

say "sync: SDK records == gully-core deployments == gullycore.xyz/manifest.json"
pnpm sync-check

say "tarball smoke test (fresh project, read-only quotes on testnet and Base)"
node scripts/smoke-pack.mjs --keep

PROV=()
if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then PROV=(--provenance); fi

publish_one() {
  local dir="$1" name version tgz
  name="$(node -p "require('./packages/$dir/package.json').name")"
  version="$(node -p "require('./packages/$dir/package.json').version")"
  tgz="$(ls .smoke/tarballs/"$(echo "$name" | sed 's#^@##; s#/#-#')"-"$version".tgz)"
  say "$name@$version  ($tgz)"
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "already on npm: skipped"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    npm publish "$tgz" --access public --dry-run
  else
    npm publish "$tgz" --access public "${PROV[@]}"
    for i in 1 2 3 4 5 6; do
      if npm view "$name@$version" version >/dev/null 2>&1; then echo "on npm: $name@$version"; return 0; fi
      sleep 10
    done
    echo "published, but npm view does not show $name@$version yet" >&2
  fi
}

if [ "$DRY" = 0 ] && [ "$YES" = 0 ]; then
  read -r -p "Publish the five packages above to npm? Type PUBLISH: " ans
  [ "$ans" = "PUBLISH" ] || { echo "stopped"; exit 1; }
fi

publish_one sdk
publish_one connect
publish_one widgets
publish_one create-gully-core-app
publish_one cli

say "done"
if [ "$DRY" = 0 ]; then
  echo "tag this commit: git tag -a v$(node -p "require('./packages/sdk/package.json').version") -m release && git push origin --tags"
fi
