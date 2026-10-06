. /usr/local/lib/skill-evals/fixture.sh
new_repo
ts_scaffold
commit_file knowledge/project/llteacher.md '---
title: LLTeacher v2 project overview
type: Project
description: AI tutoring platform; instructors author homework, students work sections in a Socratic chat with an LLM tutor
generated: true
---

PRs target staging; always pass -R uw-ssec/llteacher to gh.' "docs(memory): record the project overview" 4
commit_file knowledge/project/current-state.md '---
title: Project state as of 2026-10-06
type: Fact
description: Parity has largely landed; the first AWS production release is the active frontier
generated: true
---

The first production release is in flight.' "docs(memory): record the current state" 4
commit_file knowledge/architecture/system-overview.md '---
title: LLTeacher v2 system overview
type: Architecture
description: One Node process serves the Hono API at /api, the admin SPA at /admin and the web SPA at /
generated: true
---

apps/web holds the student SPA and the only backend.' "docs(memory): record the system overview" 4
commit_file knowledge/requirements/tenant-scoped-data-access.md '---
title: Tenant-scoped data access
type: Requirement
description: Repositories take a branded scope; routes never query tables directly
governance: constraint
generated: true
---

Every query is tenant-scoped.' "docs(memory): record the tenancy requirement" 4
mkdir -p /fixture/okf
printf 'requirements/tenant-scoped-data-access  Requirement  Repositories take a branded scope  (governance: constraint)\narchitecture/data-model-multi-tenancy  Architecture  Data model and shared-schema multi-tenancy\n' > /fixture/okf/search.txt
finish_fixture
