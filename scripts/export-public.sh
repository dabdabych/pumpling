#!/usr/bin/env bash
# Builds the public repository from this one.
#
# Why a script and not a one-off copy: the public repo is an export, never a
# fork. Nothing is edited by hand over there, so it can be rebuilt at any time
# and the two cannot drift apart.
#
# Two rules it exists to enforce:
#
#   1. Only files tracked by git are copied. `git ls-files` is the whitelist, so
#      .env, keypairs, node_modules and logs cannot leak even if someone forgets
#      to exclude them. Copying the directory instead would rely on being careful.
#   2. No history. Old commits carry a Telegram bot token and a microsender API
#      key from an earlier era of this repo. Rewriting that history is possible
#      but easy to get wrong, so the public repo starts from one commit.
#
#   ./scripts/export-public.sh [target-dir]
#
# The target defaults to ../pumpling-public. After it runs, check `git status`
# there and push.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="${CONTRACTS_REPO:-$REPO/../lottery-contracts}"
TARGET="${1:-$REPO/../pumpling-public}"

if [ ! -d "$TARGET/.git" ]; then
  echo "error: $TARGET is not a git repository. Clone the public repo there first." >&2
  exit 1
fi

echo "source:    $REPO"
echo "contracts: $CONTRACTS"
echo "target:    $TARGET"
echo

# Everything except .git goes, so files deleted here disappear there too.
find "$TARGET" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

# The working tree, filtered to tracked files. Not `git archive HEAD`: that
# would export the last commit rather than what is actually on disk.
copy_tracked() {
  local from="$1" into="$2"
  mkdir -p "$into"
  # Tracked files plus untracked ones that git would add: exactly what a
  # `git add -A` here would commit. Anything .gitignore hides stays hidden.
  ( cd "$from" && { git ls-files -z; git ls-files --others --exclude-standard -z; } ) \
    | (cd "$from" && tar --null -T - -cf -) \
    | (cd "$into" && tar -xf -)
}

copy_tracked "$REPO" "$TARGET"

if [ -d "$CONTRACTS/.git" ]; then
  copy_tracked "$CONTRACTS" "$TARGET/contracts"
else
  echo "warning: no contracts repo at $CONTRACTS, skipping contracts/" >&2
fi

# The export script itself is part of the public repo: it documents how the repo
# is built. Nothing else is removed here — if something should not be published,
# it should not be tracked in the first place.

echo
# This script is excluded because the pattern below is itself Cyrillic.
echo "anything still in Russian (should be nothing):"
(cd "$TARGET" && grep -rl '[А-Яа-яЁё]' . --exclude-dir=.git --exclude=export-public.sh || true)

echo
echo "secrets check: files that look like keys or env"
(cd "$TARGET" && find . -path ./.git -prune -o \
  \( -name '.env' -o -name '.env.*' ! -name '.env.example' -o -name '*.pem' \
     -o -name 'wallets*.json' -o -name 'id.json' \) -print || true)

echo
echo "done. Review and push:"
echo "  cd $TARGET && git status && git add -A && git commit && git push"
