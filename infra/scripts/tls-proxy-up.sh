#!/usr/bin/env bash
set -euo pipefail
if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
root=$(cd "$(dirname "$0")/../.." && pwd)
cert_dir="$root/.floci/certs"
[[ -f "$cert_dir/llteacher.local.pem" && -f "$cert_dir/llteacher.local-key.pem" ]] || {
  echo "Run infra/scripts/install-local-cert.sh before starting the HTTPS proxy." >&2
  exit 1
}
docker rm --force llteacher-local-tls >/dev/null 2>&1 || true
docker run -d --name llteacher-local-tls -p 443:443 \
  -v "$cert_dir:/certs:ro" -v "$root/infra/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine >/dev/null
