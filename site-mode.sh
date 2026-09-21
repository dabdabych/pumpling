#!/bin/sh
#
# Open or close the public site.
#
#   ./site-mode.sh                  what is it right now
#   ./site-mode.sh closed           show the holding page
#   ./site-mode.sh open             show the app
#   ./site-mode.sh closed .env.dev  the same on a stand
#
# Closed means nginx serves `coming-soon.html` instead of `index.html`, so the
# app shell is never delivered: no commit button to press, no API calls going
# out, nothing for somebody to switch back on from devtools. Everything behind
# it keeps running, which is the point. Rounds are a separate switch, through
# the admin API (`/lottery/cycles/{type}/stop` and `/resume`), because closing
# the site and stopping the round cycle are different decisions.
#
# Nothing is rebuilt. It edits SITE_ENTRY in the environment file and restarts
# the one container, which takes a few seconds.

set -eu

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

MODE="${1:-status}"
ENV_FILE="${2:-${ENV_FILE:-.env}}"
export ENV_FILE

if [ ! -f "$ENV_FILE" ]; then
    echo "Environment file not found: $ENV_FILE" >&2
    exit 1
fi

current_entry() {
    entry="$(sed -n 's/^SITE_ENTRY=\(.*\)$/\1/p' "$ENV_FILE" | tail -1)"
    # Unset means open: the compose default is index.html, and a site that
    # closes itself because a line is missing would be the wrong way round.
    [ -n "$entry" ] || entry="index.html"
    echo "$entry"
}

describe() {
    case "$1" in
        coming-soon.html) echo "closed (holding page)" ;;
        index.html)       echo "open (the app)" ;;
        *)                echo "$1" ;;
    esac
}

case "$MODE" in
    status)
        echo "$ENV_FILE: $(describe "$(current_entry)")"
        exit 0
        ;;
    open)   ENTRY="index.html" ;;
    closed) ENTRY="coming-soon.html" ;;
    *)
        echo "usage: $0 [open|closed|status] [env-file]" >&2
        exit 2
        ;;
esac

WAS="$(current_entry)"
if [ "$WAS" = "$ENTRY" ]; then
    echo "Already $(describe "$ENTRY"); nothing to do."
    exit 0
fi

# Rewritten rather than appended: a second SITE_ENTRY line further down would
# win silently, and the next person would read the first one.
if grep -q '^SITE_ENTRY=' "$ENV_FILE"; then
    tmp="$(mktemp "${TMPDIR:-/tmp}/site-entry.XXXXXX")"
    sed "s|^SITE_ENTRY=.*|SITE_ENTRY=$ENTRY|" "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"
    rm -f "$tmp"
else
    printf '\nSITE_ENTRY=%s\n' "$ENTRY" >> "$ENV_FILE"
fi

. "$ROOT_DIR/scripts/deployment-env.sh"
setup_deployment_env

echo "Site: $(describe "$WAS") -> $(describe "$ENTRY")"
docker compose --env-file "$COMPOSE_ENV_FILE" up -d ui

echo ""
echo "Done. Check it with:  curl -s https://\$APP_DOMAIN/ | grep -o '<title>[^<]*</title>'"
