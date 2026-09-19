#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building image: lottery-vrf-service:0.0.1"
docker build -t lottery-vrf-service:0.0.1 .

echo "Removing old container (if exists): lottery-vrf-service-local"
docker rm -f lottery-vrf-service-local >/dev/null 2>&1 || true

echo "Starting container: lottery-vrf-service-local (8788 -> 8787)"
docker run -d \
  --name lottery-vrf-service-local \
  --env-file .env \
  -p 8788:8787 \
  lottery-vrf-service:0.0.1

echo "Done."
echo "Logs: docker logs -f lottery-vrf-service-local"
