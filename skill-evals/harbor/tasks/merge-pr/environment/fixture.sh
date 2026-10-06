. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
push_all
$G -C "$REPO" checkout -q -b feat/due-date-label
commit_file apps/web/src/server/routes/homeworks.ts 'export function dueLabel(due: string | null): string {
  return due ? `Due ${due}` : "No due date";
}' "feat(api): label homeworks without a due date" 2
commit_file apps/web/src/server/routes/homeworks.test.ts 'import { expect, test } from "vitest";
import { dueLabel } from "./homeworks";

test("no due date", () => expect(dueLabel(null)).toBe("No due date"));' "test(api): cover the missing due date" 1
$G -C "$REPO" push -q -u origin feat/due-date-label

mkdir -p /fixture/gh
cat > /fixture/gh/pr.json <<'EOF'
{
  "number": 501,
  "title": "feat(api): label homeworks without a due date",
  "state": "OPEN",
  "headRefName": "feat/due-date-label",
  "baseRefName": "staging",
  "mergeable": "MERGEABLE",
  "mergeStateStatus": "CLEAN",
  "statusCheckRollup": [{"name": "test", "conclusion": "SUCCESS"}]
}
EOF
finish_fixture
