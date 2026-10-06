#!/bin/bash
set -euo pipefail
cd /app
npm run tutor:eval
npm test --workspace=evals
