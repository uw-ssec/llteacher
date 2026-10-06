. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
commit_file knowledge/decisions/course-scoped-tenancy.md '---
id: decisions/course-scoped-tenancy
title: Scope every row to a course
type: Decision
description: Course is the tenancy boundary; every domain table carries course_id
governance: constraint
code_refs:
  - apps/web/src/db/schema/homeworks.ts
generated: true
---
Course is the tenancy boundary.' "docs(memory): record the tenancy decision" 3
mkdir -p /fixture/okf
printf 'decisions/course-scoped-tenancy  Decision  Course is the tenancy boundary; every domain table carries course_id  (governance: constraint)\n' > /fixture/okf/search.txt
finish_fixture
