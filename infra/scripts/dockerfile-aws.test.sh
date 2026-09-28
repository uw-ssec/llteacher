#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
dockerfile="$root/Dockerfile.aws"
bundle=/usr/local/share/ca-certificates/rds-us-west-2-bundle.pem

grep -Fq "https://truststore.pki.rds.amazonaws.com/us-west-2/us-west-2-bundle.pem" "$dockerfile"
grep -Fq "openssl crl2pkcs7 -nocrl -certfile $bundle" "$dockerfile"
grep -Fq "NODE_EXTRA_CA_CERTS=$bundle" "$dockerfile"
grep -Fq 'npm ci --omit=dev --workspace=llteacher-web --workspace=@llteacher/ui --include-workspace-root=false' "$dockerfile"
grep -Fq 'rm -rf node_modules/typescript node_modules/vite' "$dockerfile"
