#!/bin/sh

set -eu

PLUGIN_ALIAS="${LOKI_DOCKER_PLUGIN_ALIAS:-loki}"
PLUGIN_IMAGE="${LOKI_DOCKER_PLUGIN_IMAGE:-grafana/loki-docker-driver}"
PLUGIN_VERSION="${LOKI_DOCKER_DRIVER_VERSION:-3.4.2}"
PLUGIN_ARCH="${LOKI_DOCKER_DRIVER_ARCH:-}"
PLUGIN_INSTALL_RETRIES="${LOKI_DOCKER_PLUGIN_RETRIES:-3}"
PLUGIN_RETRY_DELAY_SEC="${LOKI_DOCKER_PLUGIN_RETRY_DELAY_SEC:-5}"

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ docker was not found in PATH."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "❌ Cannot access the Docker daemon. Check the current user's permissions."
  exit 1
fi

detect_arch() {
  arch_raw="$(uname -m)"
  case "$arch_raw" in
    x86_64|amd64)
      echo "amd64"
      ;;
    aarch64|arm64)
      echo "arm64"
      ;;
    *)
      echo "❌ Unsupported architecture: ${arch_raw}. Set LOKI_DOCKER_DRIVER_ARCH manually." >&2
      exit 1
      ;;
  esac
}

if [ -z "$PLUGIN_ARCH" ]; then
  PLUGIN_ARCH="$(detect_arch)"
fi

plugin_line="$(
  docker plugin ls --format '{{.Name}} {{.Enabled}}' 2>/dev/null \
    | awk -v alias="$PLUGIN_ALIAS" '$1 ~ ("^" alias "(:|$)") { print; exit }'
)"

install_plugin_ref() {
  plugin_ref="$1"
  attempt=1
  while [ "$attempt" -le "$PLUGIN_INSTALL_RETRIES" ]; do
    echo "ℹ️  Installing ${plugin_ref} (attempt ${attempt}/${PLUGIN_INSTALL_RETRIES})..."
    if docker plugin install "$plugin_ref" --alias "$PLUGIN_ALIAS" --grant-all-permissions; then
      return 0
    fi

    if [ "$attempt" -lt "$PLUGIN_INSTALL_RETRIES" ]; then
      echo "⚠️  Failed to install ${plugin_ref}; retrying in ${PLUGIN_RETRY_DELAY_SEC}s..."
      sleep "$PLUGIN_RETRY_DELAY_SEC"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

if [ -z "$plugin_line" ]; then
  echo "ℹ️  Logging driver plugin '${PLUGIN_ALIAS}' was not found. Starting automatic installation..."

  if echo "$PLUGIN_VERSION" | grep -Eq '.+-(amd64|arm64)$'; then
    tag_candidates="$PLUGIN_VERSION latest-${PLUGIN_ARCH} latest"
  else
    tag_candidates="${PLUGIN_VERSION}-${PLUGIN_ARCH} ${PLUGIN_VERSION} latest-${PLUGIN_ARCH} latest"
  fi

  installed=false
  for tag in $tag_candidates; do
    if install_plugin_ref "${PLUGIN_IMAGE}:${tag}"; then
      installed=true
      break
    fi
  done

  if [ "$installed" != "true" ]; then
    echo "❌ Failed to install the Loki plugin automatically." >&2
    echo "Check host access to docker.io and DNS/firewall settings, then run deploy again." >&2
    exit 1
  fi
else
  plugin_name="$(printf '%s\n' "$plugin_line" | awk '{print $1}')"
  plugin_enabled="$(printf '%s\n' "$plugin_line" | awk '{print $2}')"
  if [ "$plugin_enabled" != "true" ]; then
    echo "ℹ️  Found ${plugin_name}, but it is disabled. Enabling it..."
    docker plugin enable "$plugin_name"
  else
    echo "✅ Plugin ${plugin_name} is already installed and enabled."
  fi
fi

docker plugin ls --format '{{.Name}} {{.Enabled}}' \
  | awk -v alias="$PLUGIN_ALIAS" '$1 ~ ("^" alias "(:|$)") { print "✅ Loki plugin is ready: " $1 " enabled=" $2 }'
