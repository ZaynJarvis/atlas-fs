#!/usr/bin/env bash
# One-shot: create a new GitHub repo from this folder and push.
# Requires: gh CLI (https://cli.github.com), authenticated via `gh auth login`.
#
# Usage:
#   ./deploy.sh                    # interactive — prompts for repo name
#   ./deploy.sh atlas-fs           # creates ZaynJarvis/atlas-fs (or current gh user)
#   ./deploy.sh atlas-fs --private # private repo
set -euo pipefail

REPO_NAME="${1:-}"
VISIBILITY="--public"
[[ "${2:-}" == "--private" ]] && VISIBILITY="--private"

if [[ -z "$REPO_NAME" ]]; then
  read -rp "Repo name (e.g. atlas-fs): " REPO_NAME
fi
if [[ -z "$REPO_NAME" ]]; then
  echo "Repo name required." >&2; exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found. Install: https://cli.github.com" >&2; exit 1
fi

# init repo if needed
if [[ ! -d .git ]]; then
  git init -b main
fi

git add -A
git diff --cached --quiet || git commit -m "Atlas: initial commit"

# create repo + push
gh repo create "$REPO_NAME" $VISIBILITY --source=. --remote=origin --push

OWNER=$(gh repo view --json owner -q .owner.login)
echo
echo "✓ Pushed to https://github.com/$OWNER/$REPO_NAME"

# enable Pages with GitHub Actions as source
gh api -X POST "repos/$OWNER/$REPO_NAME/pages" \
  -f "build_type=workflow" 2>/dev/null \
  || gh api -X PUT "repos/$OWNER/$REPO_NAME/pages" \
       -f "build_type=workflow" 2>/dev/null \
  || echo "Note: enable Pages manually at Settings → Pages → Source: GitHub Actions"

echo "✓ Pages will deploy via .github/workflows/pages.yml"
echo "  Site URL (after first deploy): https://$OWNER.github.io/$REPO_NAME/"
