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
  --add-host=host.docker.internal:host-gateway \
  -v "$cert_dir:/certs:ro" -v "$root/infra/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine@sha256:de23def33b17fb5d1290b0f6c2add1d70780e52341896c00a4c8a2a2fe9d355e >/dev/null
