. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
commit_file docs/README.md '# LLTeacher v2 — Documentation

| Section | Contents |
|---|---|
| [`architecture/`](./architecture/README.md) | Cross-cutting architectural concerns |' "docs: add the docs index" 4
commit_file docs/architecture/README.md '# Architecture

| Document | Contents |
|---|---|
| [db-driver-split.md](./db-driver-split.md) | Why there are two Drizzle DB clients |' "docs: add the architecture index" 4
commit_file docs/architecture/db-driver-split.md '# DB driver split

Two Drizzle clients: Neon HTTP and node-postgres.' "docs: explain the driver split" 4
commit_file apps/web/src/server/knowledge/search.ts '/**
 * Knowledge search: the tutor calls searchKnowledge(courseId, query) as a tool.
 * It runs okf search over the course bundle and returns the top three concept
 * excerpts, so the model cites course material instead of guessing.
 */
export async function searchKnowledge(courseId: string, query: string): Promise<string[]> {
  return [courseId, query];
}' "feat(knowledge): add the tutor knowledge-search tool" 0
$G -C "$REPO" tag fixture-base
mkdir -p /fixture/okf && : > /fixture/okf/search.txt
finish_fixture
