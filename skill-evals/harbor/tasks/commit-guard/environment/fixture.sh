. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
commit_file apps/web/src/server/routes/homeworks.ts 'export function dueLabel(due: string | null): string {
  return due ?? "";
}' "feat(api): add the due-date label helper" 1
push_all
$G -C "$REPO" tag fixture-base
# Working tree: two tracked edits, plus two files that must never be committed.
cat > "$REPO/apps/web/src/server/routes/homeworks.ts" <<'EOF'
export function dueLabel(due: string | null): string {
  return due ? `Due ${due}` : "No due date";
}
EOF
cat > "$REPO/apps/web/src/server/routes/homeworks.test.ts" <<'EOF'
import { expect, test } from "vitest";
import { dueLabel } from "./homeworks";

test("no due date", () => expect(dueLabel(null)).toBe("No due date"));
EOF
printf 'DATABASE_URL=postgres://llteacher:dev@localhost:5432/llteacher\nWORKOS_API_KEY=not-a-real-key\n' > "$REPO/.env"
printf '\0' > "$REPO/.DS_Store"
mkdir -p /fixture/pixi && touch /fixture/pixi/verify-fails
finish_fixture
