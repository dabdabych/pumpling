#!/bin/sh

BASE_ENV_FILE="${BASE_ENV_FILE:-.env}"
ENV_FILE="${ENV_FILE:-$BASE_ENV_FILE}"
COMPOSE_ENV_FILE=""

cleanup_deployment_env() {
    if [ -n "$COMPOSE_ENV_FILE" ] && [ "$COMPOSE_ENV_FILE" != "$BASE_ENV_FILE" ]; then
        rm -f "$COMPOSE_ENV_FILE"
    fi
}

setup_deployment_env() {
    if [ ! -f "$BASE_ENV_FILE" ]; then
        echo "Base environment file not found: $BASE_ENV_FILE" >&2
        exit 1
    fi

    if [ ! -f "$ENV_FILE" ]; then
        echo "Deployment environment file not found: $ENV_FILE" >&2
        exit 1
    fi

    if [ "$ENV_FILE" = "$BASE_ENV_FILE" ]; then
        COMPOSE_ENV_FILE="$BASE_ENV_FILE"
        return
    fi

    COMPOSE_ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/lottery-env.XXXXXX")"
    awk '
        function env_key(line, key) {
            if (line !~ /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/) {
                return ""
            }
            key = line
            sub(/^[[:space:]]*/, "", key)
            sub(/[[:space:]]*=.*$/, "", key)
            return key
        }

        FNR == NR {
            key = env_key($0)
            if (key != "") {
                if (!(key in override_lines)) {
                    override_order[++override_count] = key
                }
                override_lines[key] = $0
            }
            next
        }

        {
            key = env_key($0)
            if (key != "" && key in override_lines) {
                print override_lines[key]
                emitted[key] = 1
            } else {
                print
            }
        }

        END {
            for (i = 1; i <= override_count; i++) {
                key = override_order[i]
                if (!(key in emitted)) {
                    print override_lines[key]
                }
            }
        }
    ' "$ENV_FILE" "$BASE_ENV_FILE" > "$COMPOSE_ENV_FILE"

    trap cleanup_deployment_env EXIT HUP INT TERM
}

compose() {
    docker compose --env-file "$COMPOSE_ENV_FILE" "$@"
}
