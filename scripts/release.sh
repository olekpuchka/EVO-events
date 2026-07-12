#!/usr/bin/env bash
# Cut a release: bump the version, commit, tag, and push — in the one order that
# keeps package.json, package-lock.json, and the git tag pointing at the same commit.
# The tag push triggers the Deploy workflow (.github/workflows/deploy.yml).
#
# Usage:
#   npm run release              # patch bump (2.3.4 -> 2.3.5)
#   npm run release -- minor     # minor bump (2.3.4 -> 2.4.0)
#   npm run release -- major     # major bump (2.3.4 -> 3.0.0)
#   npm run release -- 2.5.0     # explicit version
set -euo pipefail

BUMP="${1:-patch}"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != "master" ]; then
  echo "error: release must be run from master (currently on '$branch')" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean — commit or stash changes first" >&2
  exit 1
fi

git fetch origin master --quiet
if [ -n "$(git rev-list HEAD..origin/master)" ]; then
  echo "error: local master is behind origin/master — pull first" >&2
  exit 1
fi

# npm version bumps package.json + package-lock.json, creates a commit, and
# creates the matching vX.Y.Z tag on that commit — all atomically.
new_version=$(npm version "$BUMP" -m "chore: release v%s")
echo "Bumped to ${new_version}"

# Push the commit and its tag together. The tag push fires the Deploy Action.
git push origin master --follow-tags
echo "Pushed ${new_version} — the Deploy workflow will run on the tag."
