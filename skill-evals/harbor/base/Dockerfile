FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Shared bash libraries: shim logging, fixture builders, verifier helpers.
COPY lib/ /usr/local/lib/skill-evals/

# Fake CLIs, plus a git wrapper that logs before delegating to /usr/bin/git.
# npm/npx/pulumi/docker/uv are fakes too: no task ever reaches a real
# registry, database, AWS account, or Docker daemon.
COPY shims/gh shims/pixi shims/okf shims/git shims/npm shims/npx shims/pulumi shims/docker shims/uv /usr/local/bin/
COPY shims/forbidden /usr/local/bin/pip
COPY shims/forbidden /usr/local/bin/pip3
COPY shims/forbidden /usr/local/bin/conda
RUN chmod 755 /usr/local/bin/gh /usr/local/bin/pixi /usr/local/bin/okf /usr/local/bin/git \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/pulumi /usr/local/bin/docker /usr/local/bin/uv \
      /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/conda \
 && mkdir -p /var/log/skill-shims /fixture /app /remote \
 && chmod 777 /var/log/skill-shims \
 && /usr/bin/git config --system user.name "Skill Evals" \
 && /usr/bin/git config --system user.email "evals@example.invalid" \
 && /usr/bin/git config --system init.defaultBranch staging

# Every skill under test, synced from .agents/skills by
# `pixi run -e evals harbor-sync`. task.toml points skills_dir at /skills.
# The check guards against the copy nesting under /skills/skills/.
COPY skills/ /skills/
RUN test -f /skills/commit/SKILL.md && test -f /skills/db-migration/SKILL.md

WORKDIR /app
