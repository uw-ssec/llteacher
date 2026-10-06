#!/bin/bash
set -euo pipefail
cd /app
git log --oneline -20
git log --oneline --since="8 hours ago"
cat docs/README.md docs/architecture/README.md
pixi run okf search "knowledge search tool"
cat > docs/architecture/knowledge-search.md <<'EOF'
# Knowledge search

The tutor's `searchKnowledge(courseId, query)` tool runs okf search over the
course's knowledge bundle and returns the top three concept excerpts.

```mermaid
sequenceDiagram
    Tutor->>searchKnowledge: tool call (courseId, query)
    searchKnowledge->>okf: search course bundle
    okf-->>searchKnowledge: top 3 concepts
    searchKnowledge-->>Tutor: excerpts to cite
```
EOF
printf '| [knowledge-search.md](./knowledge-search.md) | How the tutor searches a course knowledge bundle |\n' >> docs/architecture/README.md
ls docs/architecture/knowledge-search.md
pixi run pre-commit
