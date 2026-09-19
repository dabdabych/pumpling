#!/bin/sh
set -eu

APP_DOMAIN="${APP_DOMAIN:-pumpling.xyz}"
CERT_DIR="/etc/letsencrypt/live/$APP_DOMAIN"

if [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; then
    echo "TLS certificate for $APP_DOMAIN is missing in $CERT_DIR." >&2
    echo "Run ./create-ssl-cert.sh with the same environment file before deployment." >&2
    exit 1
fi
