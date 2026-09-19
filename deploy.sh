#!/bin/sh

set -eu

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

BASE_ENV_FILE="${BASE_ENV_FILE:-.env}"
ENV_FILE="${1:-${ENV_FILE:-$BASE_ENV_FILE}}"

. "$ROOT_DIR/scripts/deployment-env.sh"
setup_deployment_env

echo "Using deployment environment: $ENV_FILE"

echo "📥 Updating repository (git pull)..."
git pull

echo "⚙️  Building all services with docker compose..."
compose build

echo "🧩 Checking the Loki Docker logging plugin..."
./scripts/ensure-loki-docker-plugin.sh

echo "🔔 Rendering the Grafana alert contact point..."
./scripts/render-alerting.sh "$COMPOSE_ENV_FILE"

echo "🚀 Starting docker compose..."
compose up -d --remove-orphans

echo ""
echo "✅ Services have been built and started."
