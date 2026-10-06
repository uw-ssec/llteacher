#!/bin/bash
set -euo pipefail
cd /app
export APP_URL=http://localhost:2311 LLMOXIE_BASE_URL=http://localhost:4000 LLMOXIE_API_KEY=dev-key \
  DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher WORKOS_API_KEY=x WORKOS_CLIENT_ID=x \
  WORKOS_WEBHOOK_SECRET=x SESSION_SECRET=x ENCRYPTION_KEY=x BLIND_INDEX_KEY=x KNOWLEDGE_ROOT=/app/.knowledge
npm run node:serve
npm run dev
