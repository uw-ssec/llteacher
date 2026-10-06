. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
push_all
$G -C "$REPO" tag fixture-base
mkdir -p "$REPO/apps/web/src/server/routes"
printf 'export const grade = (n: number): number => Math.max(0, Math.min(100, n));\n' > "$REPO/apps/web/src/server/routes/grades.ts"
printf 'import { expect, test } from "vitest";\nimport { grade } from "./grades";\n\ntest("clamps", () => expect(grade(120)).toBe(100));\n' > "$REPO/apps/web/src/server/routes/grades.test.ts"
finish_fixture
