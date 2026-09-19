#!/bin/bash

# Simple script to create SSL certificate using certbot standalone
# Run this manually when you need to create/renew certificate

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

BASE_ENV_FILE="${BASE_ENV_FILE:-.env}"
ENV_FILE="${1:-${ENV_FILE:-$BASE_ENV_FILE}}"

. "$ROOT_DIR/scripts/deployment-env.sh"
setup_deployment_env

env_value() {
    local key="$1"
    local value
    value="$(
        awk -v key="$key" '
            /^[[:space:]]*#/ { next }
            {
                line = $0
                sub(/\r$/, "", line)
                if (line ~ "^[[:space:]]*" key "[[:space:]]*=") {
                    sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", "", line)
                    print line
                }
            }
        ' "$BASE_ENV_FILE" "$ENV_FILE" | tail -n 1
    )"
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    printf '%s' "$value"
}

env_has_key() {
    local key="$1"
    awk -v key="$key" '
        /^[[:space:]]*#/ { next }
        $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { found = 1 }
        END { exit(found ? 0 : 1) }
    ' "$BASE_ENV_FILE" "$ENV_FILE"
}

DOMAIN="$(env_value APP_DOMAIN)"
EMAIL="$(env_value CERTBOT_EMAIL)"

DOMAIN="${DOMAIN:-pumpling.xyz}"
EMAIL="${EMAIL:-admin@$DOMAIN}"
if env_has_key APP_DOMAIN_ALIASES; then
    DOMAIN_ALIASES="$(env_value APP_DOMAIN_ALIASES)"
else
    DOMAIN_ALIASES="www.$DOMAIN"
fi

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
    echo "Invalid APP_DOMAIN: $DOMAIN" >&2
    exit 1
fi

CERTBOT_DOMAIN_ARGS=(-d "$DOMAIN")
for alias in $DOMAIN_ALIASES; do
    if [[ ! "$alias" =~ ^[A-Za-z0-9.-]+$ ]]; then
        echo "Invalid domain in APP_DOMAIN_ALIASES: $alias" >&2
        exit 1
    fi
    CERTBOT_DOMAIN_ARGS+=(-d "$alias")
done

echo "=========================================="
echo "SSL Certificate Creation"
echo "Environment: $ENV_FILE"
echo "Domain: $DOMAIN"
if [ -n "$DOMAIN_ALIASES" ]; then
    echo "Aliases: $DOMAIN_ALIASES"
fi
echo "Email: $EMAIL"
echo "=========================================="
echo ""

# Check if certbot is installed
if ! which certbot > /dev/null 2>&1; then
    echo "❌ Certbot is not installed!"
    echo ""
    echo "Install it with:"
    echo "  sudo apt update && sudo apt install certbot -y"
    exit 1
fi

echo "✅ Certbot found: $(which certbot)"
echo "   Version: $(certbot --version 2>&1 | head -n1)"
echo ""

# Check if port 80 is free
STACK_STOPPED=0
if lsof -Pi :80 -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "⚠️  Port 80 is in use. Stopping Docker containers..."
    compose down
    STACK_STOPPED=1
    sleep 2
fi

# Create certificate
echo "🔐 Creating SSL certificate..."
echo ""

if sudo certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    "${CERTBOT_DOMAIN_ARGS[@]}"; then
    echo ""
    echo "=========================================="
    echo "✅ Certificate created successfully!"
    echo "=========================================="
    echo ""
    echo "Certificate files are located at:"
    echo "  /etc/letsencrypt/live/$DOMAIN/"
    echo ""
    echo "Files:"
    echo "  - fullchain.pem (certificate + chain)"
    echo "  - privkey.pem (private key)"
    echo "  - cert.pem (certificate only)"
    echo "  - chain.pem (chain only)"
    echo ""
    echo "To renew certificate in the future, run:"
    echo "  sudo certbot renew"
    echo ""
    if [ "$STACK_STOPPED" -eq 1 ]; then
        echo "Starting Docker containers back..."
        compose up -d
    fi
else
    echo ""
    echo "=========================================="
    echo "❌ Certificate creation failed!"
    echo "=========================================="
    echo ""
    echo "Troubleshooting:"
    echo "  1. Make sure port 80 is accessible from internet"
    echo "  2. Check DNS: dig +short $DOMAIN"
    echo "  3. Check firewall: sudo ufw status"
    echo ""
    exit 1
fi
