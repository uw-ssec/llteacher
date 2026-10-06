---
type: Fact
title: okf binary must be v0.3.0; KNOWLEDGE_ROOT cannot be a symlink
description: "The knowledge service shells out to okf; Dockerfile.aws, test.yml and release.yml pin okf v0.3.0 with checksum checks. Local installs may differ (v0.1.5 seen); KNOWLEDGE_ROOT must be a real path, not macOS /tmp."
tags: [okf, knowledge, dependencies, gotcha]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:30:53Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/server/knowledge/okfCli.ts", "Dockerfile.aws", ".github/workflows/test.yml", ".github/workflows/release.yml", "apps/web/src/server/knowledge/okfCli.test.ts"]
sources:
  - resource: "apps/web/README.md"
  - resource: "Dockerfile.aws"
  - resource: ".github/workflows/test.yml"
---

`OkfKnowledgeService` runs the `okf` CLI (path from `OKF_BINARY`, default `okf` on PATH) for init/search/show/validate/create. The version is pinned to **0.3.0** in three places, each downloading the GitHub release asset and verifying it against `checksums.txt`:

- `Dockerfile.aws` (`ARG OKF_VERSION=0.3.0`, `okf-linux-${TARGETARCH}`), also installs `poppler-utils` for OCR page renders;
- `.github/workflows/test.yml` and `release.yml` ("Install okf 0.3.0").

Bump all three together, and re-run the knowledge tests against the new binary.

**Local mismatch is common.** The dev machine this was checked on had `okf version v0.1.5` from Homebrew, and the real-binary tests still ran (they `skipIf(!okfAvailable())`, not on version). Passing locally against another okf version does not prove compatibility with 0.3.0. Install per apps/web/README.md: `brew install okf-memory/tap/okf`, confirm `okf version` prints v0.3.0, otherwise download `okf-darwin-arm64` from the v0.3.0 release and put it first on PATH or set `OKF_BINARY`.

**KNOWLEDGE_ROOT.** okf refuses a symlinked root; the app resolves it with `realpath`. On macOS `/tmp` is a symlink to `/private/tmp`, so `KNOWLEDGE_ROOT=/tmp/...` fails. Use `mkdir -p .knowledge && export KNOWLEDGE_ROOT=$(pwd)/.knowledge` (gitignored). The server `mkdir -p`s it at startup.

**Production durability:** with `STORAGE_BUCKET` set, KNOWLEDGE_ROOT is only a working copy restored from S3 snapshots. Do not point production at an unreviewed legacy directory; a nonempty local course with no remote snapshot is refused. Back up `originals/` (pre-edit bodies kept outside the searchable bundle).

Unrelated to the app's okf usage: the OKF agent-memory bundle tooling for this repo (if any) uses the same CLI; do not confuse course bundles under KNOWLEDGE_ROOT with project-memory bundles.
