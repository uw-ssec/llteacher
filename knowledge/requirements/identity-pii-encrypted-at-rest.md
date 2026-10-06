---
type: Requirement
title: "Identity PII is encrypted at rest with AES-256-GCM, and lookups go through HMAC blind indexes"
description: "No plaintext email, netid or display name is ever written to users; encryption and blind-index keys are separate, env-loaded, never committed; Drizzle relational joins must not read encrypted columns."
tags: [security, pii, encryption, ferpa]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/lib/crypto/identity-cipher.ts, apps/web/src/lib/crypto/keys.ts, apps/web/src/db/types/encrypted.ts, apps/web/src/lib/secrets-loader.ts, apps/web/src/lib/services/UserIdentityService.ts, apps/web/src/db/schema/identity.ts]
sources:
  - resource: docs/architecture/multi-tenant-data-model.md
  - resource: docs/superpowers/plans/2026-07-31-m1-auth-workos.md
  - resource: docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md
  - resource: docs/superpowers/plans/2026-08-05-m3-homeworks-submissions-parity.md
  - resource: docs/adr/0001-operator-owned-production-secrets.md
---

## The requirement
From data-model decisions 1 and 4, and the M1 global constraints:
- `users.email`, `netid`, and `display_name` are **always** written through `IdentityCipher.encryptString` (AES-256-GCM, WebCrypto). Equality lookups use sibling HMAC-SHA256 `*_blind_index` `bytea` columns, unique where required. `workos_user_id` stays plaintext as a pseudonymous join key. NetID is the local part of the UW email.
- `ENCRYPTION_KEY` and `BLIND_INDEX_KEY` are **separate** 32-byte keys. They load only from the environment and are never hard-coded or committed. In production they come from the GitHub production environment through Secrets Manager.
- Ciphertext carries a key id. `IdentityCipher.decryptString` hard-fails on anything other than `secrets-loader.ts` `ACTIVE_KEY_ID = "k1"`. Seeds and scripts must load keys through `loadIdentityCipherKeys()`, not hand-rolled imports (M2 decision 16).
- The sealed session cookie carries only `userId`, `workosUserId`, and timestamps.
- **Query hazard (M3 decision 10):** Drizzle relational `findMany({ with: ... })` serializes joined `bytea` through JSON. `encryptedText` then gets a string and decrypts to garbage *silently*. Read encrypted user columns with flat `select().innerJoin()`.
- Canvas API tokens reuse the same cipher (`organization_credentials.encryptedSecret`) and are masked only at response time.

## Rotation
Rotating `ENCRYPTION_KEY` or `BLIND_INDEX_KEY` needs a coordinated data migration (ADR 0001). The schema keeps a key-id slot to allow it. The data-model doc keeps open a later swap to AWS KMS for HIPAA "without schema change".

## Scope boundary
This covers identity only. Chat, grades, and student profiles follow `decisions/content-encryption-boundary`.

## Checks
- `identity-cipher.test.ts` uses real `crypto.subtle` keys.
- `seed.test.ts` decrypts a seeded email to catch key-id drift.
- CI generates ephemeral keys with `openssl rand -base64 32`.

# Related Concepts
- [PII encryption and blind indexes](../architecture/pii-encryption-blind-index.md): The encryption and blind-index implementation
