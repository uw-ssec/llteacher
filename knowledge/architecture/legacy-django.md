---
type: Architecture
title: Legacy Django app and its relation to the TS port
description: "Django 5.2 apps (accounts, conversations, homeworks, llm), src/llteacher and services/ remain as a uv workspace; the TS port targets Django parity and the root README still names Django source of truth until cutover."
tags: [architecture, legacy, django, python]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: hold
code_refs: ["apps/accounts", "apps/conversations", "apps/homeworks", "apps/llm", "src/llteacher", "services", "pyproject.toml", "run_tests.py", "Dockerfile", "docker-entrypoint.sh", "TESTING.md", "SERVICES.md", "DOCKER.md"]
sources:
  - resource: "README.md"
  - resource: "pyproject.toml"
  - resource: "TESTING.md"
  - resource: "CLAUDE.md"
  - resource: "a7cf2c3"
---

**What is there.** A Django 5.2 project (`src/llteacher`: settings, test_settings, production settings, urls) with four app packages under `apps/` (`accounts`, `conversations`, `homeworks`, `llm`) and a `services/` layer, organized as a uv workspace in the root `pyproject.toml` (Python >= 3.12, `uv_build`). The legacy container is the root `Dockerfile` + `docker-entrypoint.sh` (SQLite at `/data/llteacher.sqlite`, gunicorn). `TESTING.md`, `SERVICES.md`, `DOCKER.md`, `legacy_documentation/`, and the project `CLAUDE.md` "missing views" list describe this Django app, not the TypeScript port.

**Coexistence.** Django and TS packages share `apps/`. npm only sees `apps/web`, `apps/admin` (via `package.json` workspaces); uv only sees the Django members. Python files such as `apps/__init__.py` sit next to the TS workspaces.

**Relation to the port.** The TS stack is a full rewrite with its own Postgres schema (Drizzle), not a migration of Django models. Behaviors are ported "for Django parity" (seed accounts, graceful 500 on missing LLM key, homework/section/conversation/submission lifecycle). The root README says Django "remains the source of truth until cutover" (plan: `docs/superpowers/plans/2026-06-01-llteacher-fullstack-port.md`). In practice almost all active development, CI and the AWS release target the TS stack; no CI job runs Django tests.

**Running its tests:** `uv run python run_tests.py --settings=src.llteacher.test_settings <app>.<tests_module>` (e.g. `apps.homeworks.tests.test_section_detail_view`), using an in-memory SQLite DB. uv was not installed on the machine where this was checked, so this was not run.

**Agent guidance:** do not "fix" Django when a task concerns the product. Product changes go in `apps/web`/`apps/admin`. Treat the Django code as reference for parity questions only, and expect it to be deleted at cutover.
