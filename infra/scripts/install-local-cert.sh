#!/usr/bin/env bash
set -euo pipefail
if [[ "${PULUMI_STACK:-local}" != "local" ]]; then echo "Refusing non-local stack" >&2; exit 2; fi
command -v mkcert >/dev/null || { echo "Install mkcert first (brew install mkcert)." >&2; exit 1; }
root=$(cd "$(dirname "$0")/../.." && pwd)
cert_dir="$root/.floci/certs"
mkdir -p "$cert_dir"
mkcert -install
mkcert -cert-file "$cert_dir/llteacher.local.pem" -key-file "$cert_dir/llteacher.local-key.pem" llteacher.local
echo "Certificate: $cert_dir/llteacher.local.pem"
echo "Add this once to /etc/hosts (requires your password):"
echo "  127.0.0.1 llteacher.local"
echo "Export LLTEACHER_LOCAL_CA=$cert_dir/llteacher.local.pem before verification."
