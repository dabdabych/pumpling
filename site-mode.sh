#!/bin/sh
#
# Open or close the public site.
#
#   ./site-mode.sh                what is it right now
#   ./site-mode.sh soon           the pre-launch placeholder
#   ./site-mode.sh open           the full site
#   ./site-mode.sh closed         a hard close, a static page and nothing else
#   ./site-mode.sh soon .env.dev  the same on a stand
#
# Three states, and the middle one is the usual one before a launch:
#
#   soon    the app is served and the root shows the placeholder: the launch
#           date, sign-in and the community chat. People can register and talk
#           while the rounds are not running yet. This is what you want before
#           a launch; it is a waiting room, not a locked door.
#   open    the root shows the main page and the pools are reachable.
#   closed  nginx serves a static page and the app shell is never delivered at
#           all. For an incident, not for a launch: it takes the chat and
#           sign-in down with everything else.
#
# Rounds are a separate switch, through the admin API
# (`/lottery/cycles/{type}/stop` and `/resume`), because closing the site and
# stopping the round cycle are different decisions.
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

read_var() {
    value="$(sed -n "s/^$1=\(.*\)$/\1/p" "$ENV_FILE" | tail -1)"
    [ -n "$value" ] || value="$2"
    echo "$value"
}

current_mode() {
    entry="$(read_var SITE_ENTRY index.html)"
    soon="$(read_var COMING_SOON false)"
    # Unset means open: the compose defaults are index.html and false, and a
    # site that closes itself because a line is missing would be the wrong way
    # round.
    case "$entry:$soon" in
        coming-soon.html:*) echo closed ;;
        *:true)             echo soon ;;
        *)                  echo open ;;
    esac
}

describe() {
    case "$1" in
        closed) echo "closed (a static page, the app is not served)" ;;
        soon)   echo "pre-launch (placeholder with sign-in and chat)" ;;
        open)   echo "open (the full site)" ;;
        *)      echo "$1" ;;
    esac
}

set_var() {
    if grep -q "^$1=" "$ENV_FILE"; then
        tmp="$(mktemp "${TMPDIR:-/tmp}/site-mode.XXXXXX")"
        sed "s|^$1=.*|$1=$2|" "$ENV_FILE" > "$tmp"
        cat "$tmp" > "$ENV_FILE"
        rm -f "$tmp"
    else
        printf '\n%s=%s\n' "$1" "$2" >> "$ENV_FILE"
    fi
}

case "$MODE" in
    status)
        echo "$ENV_FILE: $(describe "$(current_mode)")"
        exit 0
        ;;
    open)   ENTRY="index.html";       SOON="false" ;;
    soon)   ENTRY="index.html";       SOON="true"  ;;
    closed) ENTRY="coming-soon.html"; SOON="false" ;;
    *)
        echo "usage: $0 [open|soon|closed|status] [env-file]" >&2
        exit 2
        ;;
esac

WAS="$(current_mode)"
if [ "$WAS" = "$MODE" ]; then
    echo "Already $(describe "$MODE"); nothing to do."
    exit 0
fi

# Rewritten rather than appended: a second line further down would win
# silently, and the next person would read the first one.
set_var SITE_ENTRY "$ENTRY"
set_var COMING_SOON "$SOON"

. "$ROOT_DIR/scripts/deployment-env.sh"
setup_deployment_env

echo "Site: $(describe "$WAS") -> $(describe "$MODE")"
docker compose --env-file "$COMPOSE_ENV_FILE" up -d ui

echo ""
echo "Done. Check it with:  curl -s https://\$APP_DOMAIN/ | grep -o '<title>[^<]*</title>'"
