---
type: Architecture
title: PII encryption and blind indexes
description: "User PII (e.g. email) is stored as AES-GCM ciphertext with a deterministic HMAC blind index for lookups; ENCRYPTION_KEY and BLIND_INDEX_KEY are required by the app, seed script and DB tests."
tags: [architecture, security, pii, crypto]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/lib/crypto/identity-cipher.ts, apps/web/src/lib/crypto/keys.ts, apps/web/src/db/types, apps/web/scripts/seed.ts]
sources:
  - resource: apps/web/src/server/middleware/roles.ts
  - resource: apps/web/README.md
  - resource: .github/workflows/test.yml
---

`IdentityCipher` (apps/web/src/lib/crypto/identity-cipher.ts) encrypts identity fields with AES-GCM under `ENCRYPTION_KEY` and computes a deterministic HMAC blind index under `BLIND_INDEX_KEY` (both 32-byte base64 keys). `users.email` is ciphertext; equality lookups (WorkOS user reconciliation, roster matching, super-admin checks) go through `emailBlindIndex`, never plaintext comparison. Emails are normalized with `IdentityCipher.normalizeEmail` before indexing.

Consequences for agents:

- **Never query or compare plaintext email columns.** Compute a blind index with the same cipher keys and compare that.
- **Keys are environment-bound.** Data encrypted with one key pair is unreadable (and blind indexes unmatchable) under another. Local seed data, CI data and production data are each tied to their own keys. CI generates throwaway keys per run (`openssl rand -base64 32` in test.yml) because its DB is torn down with the runner.
- **Seed script needs them.** `npm run db:seed` (apps/web/scripts/seed.ts) encrypts PII the same way the app does; it requires `DATABASE_URL`, `ENCRYPTION_KEY`, `BLIND_INDEX_KEY`. Seeded accounts (`teacher1`, `teacher2`, `student1..3`, org `seed-org`, course `STAT 311`) are pending rows claimable by a real WorkOS login with `teacher1@example.com` etc. The `example.com` domain is deliberate (WorkOS skips real verification for IANA-reserved domains).
- **turbo passes them through.** `turbo.json`'s `test` task declares `env: [DATABASE_URL, ENCRYPTION_KEY, BLIND_INDEX_KEY]`, so these are part of the test cache key and visible to vitest under turbo's strict env mode.
- **Rotation** is not a config flip: rotating either key requires re-encrypting or re-indexing existing rows. Production values live in GitHub `production` environment secrets (see architecture/ci-release-pipeline).

# Related Concepts
- [BLIND_INDEX_KEY drift silently forks user accounts](../bugs/blind-index-key-drift-forks-accounts.md): What key drift does to blind indexes
