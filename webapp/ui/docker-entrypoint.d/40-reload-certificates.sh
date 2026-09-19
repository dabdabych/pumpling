#!/bin/sh
set -eu

reload_interval="${NGINX_CERT_RELOAD_INTERVAL:-12h}"

(
    while sleep "$reload_interval"; do
        if nginx -t; then
            nginx -s reload
        fi
    done
) &
