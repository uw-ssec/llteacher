# Sourced by each task's environment/fixture.sh during the image build.
# Builds a git repo at /app (default branch staging, like uw-ssec/llteacher)
# with a bare remote at /remote/origin.git.
set -euo pipefail
REPO=/app
REMOTE=/remote/origin.git
G=/usr/bin/git   # bypass the logging wrapper while building fixtures

new_repo() {
  mkdir -p "$REPO" "$(dirname "$REMOTE")"
  $G init -q -b staging "$REPO"
  $G init -q --bare -b staging "$REMOTE"
  $G -C "$REPO" remote add origin "$REMOTE"
}

# commit_file <path> <content> <message> [days_ago]
commit_file() {
  local path="$1" content="$2" msg="$3" days="${4:-0}"
  local when
  when="$(date -d "$days days ago" '+%Y-%m-%dT12:00:00')"
  mkdir -p "$REPO/$(dirname "$path")"
  printf '%s\n' "$content" > "$REPO/$path"
  $G -C "$REPO" add "$path"
  GIT_AUTHOR_DATE="$when" GIT_COMMITTER_DATE="$when" $G -C "$REPO" commit -q -m "$msg"
}

push_all() {
  $G -C "$REPO" push -q -u origin --all
}

# A minimal llteacher lookalike: npm workspaces, the web app with a Drizzle
# schema and two applied migrations, pixi tooling, and an empty knowledge/.
ts_scaffold() {
  commit_file package.json '{
  "name": "llteacher-monorepo",
  "private": true,
  "workspaces": ["apps/web", "apps/admin", "evals", "infra"],
  "scripts": {
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "db:migrate": "npm run db:migrate --workspace=llteacher-web",
    "aws:local:up": "PULUMI_STACK=local ./infra/scripts/local-up.sh",
    "aws:local:verify": "PULUMI_STACK=local ./infra/scripts/verify-local-stack.sh",
    "aws:local:down": "PULUMI_STACK=local ./infra/scripts/floci-down.sh",
    "tutor:eval": "npm run tutor:eval --workspace=evals"
  }
}' "build: add the npm workspace root" 10
  commit_file apps/web/package.json '{
  "name": "llteacher-web",
  "scripts": {
    "typecheck": "tsc -b",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx scripts/migrate.ts"
  }
}' "build(web): add the web workspace" 10
  commit_file apps/web/src/db/schema.ts 'export * from "./schema/homeworks";' "feat(db): add the schema entry point" 9
  commit_file apps/web/src/db/schema/homeworks.ts 'import { pgTable, text, uuid } from "drizzle-orm/pg-core";

export const homeworks = pgTable("homeworks", {
  id: uuid("id").primaryKey().defaultRandom(),
  courseId: uuid("course_id").notNull(),
  title: text("title").notNull(),
});' "feat(db): add the homeworks table" 9
  commit_file apps/web/src/db/migrations/0000_init.sql 'CREATE TABLE "homeworks" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "course_id" uuid NOT NULL, "title" text NOT NULL);' "feat(db): add the initial migration" 9
  commit_file apps/web/src/db/migrations/0001_homework_course_idx.sql 'CREATE INDEX "homeworks_course_idx" ON "homeworks" ("course_id");' "feat(db): index homeworks by course" 8
  commit_file apps/web/src/db/migrations/meta/_journal.json '{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    { "idx": 0, "version": "7", "when": 1780517632446, "tag": "0000_init", "breakpoints": true },
    { "idx": 1, "version": "7", "when": 1780517802302, "tag": "0001_homework_course_idx", "breakpoints": true }
  ]
}' "feat(db): add the migration journal" 8
  commit_file pixi.toml '[workspace]
name = "llteacher"' "build: add pixi tooling" 7
  commit_file knowledge/index.md '---
okf_version: "0.2"
---

# Knowledge Base' "docs(memory): initialize the knowledge bundle" 7
}

# Clears logs written while building, so verifiers only see the agent's calls.
finish_fixture() {
  rm -rf /var/log/skill-shims/*
}
