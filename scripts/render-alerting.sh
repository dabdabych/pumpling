#!/bin/sh
# Builds the alert contact point from a template.
#
# Grafana cannot substitute variables in contact point settings: it parses any
# substituted value as JSON, and a numeric chat id breaks provisioning outright.
# So the values are written into the file as literals right before startup, and
# only the template stays in the repository.
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env}"
TEMPLATE="$ROOT_DIR/infra/grafana/provisioning/alerting/contact-points.yaml.tmpl"
TARGET="$ROOT_DIR/infra/grafana/provisioning/alerting/contact-points.yaml"

read_var() {
    grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

token="$(read_var TELEGRAM_ERROR_BOT_TOKEN)"
chat="$(read_var TELEGRAM_ERROR_CHAT_ID)"

if [ -z "$token" ] || [ -z "$chat" ]; then
    # No channel: remove the file, or Grafana fails on the empty values.
    rm -f "$TARGET"
    echo "ℹ️  Alert channel is not configured, contact point skipped"
    exit 0
fi

sed -e "s|__TELEGRAM_ERROR_BOT_TOKEN__|$token|" \
    -e "s|__TELEGRAM_ERROR_CHAT_ID__|$chat|" \
    "$TEMPLATE" > "$TARGET"
echo "🔔 Alert contact point rendered"
