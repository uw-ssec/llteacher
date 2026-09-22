#!/usr/bin/env bash
set -euo pipefail

image="${1:-llteacher-plan-check:local}"

docker run --rm --entrypoint /bin/sh "$image" -c '
  set -eu
  test -x /app/node_modules/.bin/tsx
  test -d /app/node_modules/pg
  test ! -e /app/node_modules/@pulumi
  test ! -e /app/node_modules/typescript
  test ! -e /app/node_modules/vite
  test -s /usr/local/share/ca-certificates/rds-us-west-2-bundle.pem
  openssl crl2pkcs7 -nocrl -certfile /usr/local/share/ca-certificates/rds-us-west-2-bundle.pem |
    openssl pkcs7 -print_certs -noout >/dev/null
  test "$NODE_EXTRA_CA_CERTS" = /usr/local/share/ca-certificates/rds-us-west-2-bundle.pem
'
