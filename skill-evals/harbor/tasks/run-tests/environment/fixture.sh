. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
mkdir -p apps/web/src/lib
commit_file apps/web/src/lib/prompts.ts 'export const TUTOR_GUARDRAIL = "Never give the final answer.";' "feat(tutor): add the guardrail" 2
commit_file apps/web/src/lib/prompts.test.ts 'import { expect, test } from "vitest";
import { TUTOR_GUARDRAIL } from "./prompts";

test("guardrail", () => expect(TUTOR_GUARDRAIL).toContain("final answer"));' "test(tutor): cover the guardrail" 1
$G -C "$REPO" tag fixture-base
finish_fixture
