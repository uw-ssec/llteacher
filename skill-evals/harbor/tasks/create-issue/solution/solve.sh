#!/bin/bash
set -euo pipefail
cd /app
gh issue create -R uw-ssec/llteacher --title "fix(web): show 'No due date' instead of crashing" --body "$(cat <<'EOF'
## Summary

The student homework list throws when a homework's due date is null.

## Requirements

- [ ] Render "No due date" for a null due date
- [ ] Cover the null case with a test
EOF
)"
