---
type: Bug
title: BLIND_INDEX_KEY drift silently forks user accounts
description: "Login matches pre-provisioned users by HMAC(email, BLIND_INDEX_KEY); a different key per developer or after rotation misses the match and silently creates a duplicate user with no memberships."
tags: [auth, crypto, identity, workos]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:30Z" }
status: stable
governance: constraint
code_refs: ["apps/web/src/lib/crypto/identity-cipher.ts", "apps/web/src/lib/services/UserIdentityService.ts", "apps/web/src/server/routes/auth.ts", "apps/web/.dev.vars.example", "apps/web/scripts/seed.ts"]
sources:
  - resource: "discussion #319"
  - resource: "issue #320"
  - resource: "issue #245"
---

## Symptom

An instructor pre-provisioned as admin on one course and student on another got the admin console's 403 "no teaching role" page after a successful WorkOS login (discussion #319).

## Root cause

`UserIdentityService.createOrClaimUser` looks up the user by `workosUserId` first. If that misses, it falls back to `emailBlindIndex = HMAC-SHA256(normalizedEmail, BLIND_INDEX_KEY)` to claim a pending row created by roster import. Two developers sharing one dev database had each generated their own `BLIND_INDEX_KEY` in a gitignored `.dev.vars`, as `.dev.vars.example` told them to. The pending row's index came from one key and the login computed the other. Nothing matched, so the code inserted a **new** user row with no course memberships, and raised no error.

## Why it is subtle

The encryption side of `identity-cipher.ts` uses an envelope with a key id (`[version][keyId][IV][ciphertext]`) and fails loudly on an unknown key. The blind index is a bare HMAC with no key id. A wrong encryption key throws. A wrong blind-index key quietly forks the account (#320). That also means `BLIND_INDEX_KEY` cannot be rotated today: there is no dual-read and no way to target a backfill.

The same mechanism made the seed test flaky (#245). `seed.ts reset()` deletes seeded users by blind index under the *current* key, so pending users seeded under earlier keys pile up. The test then decrypts an arbitrary one with `.limit(1)` and no ORDER BY.

## Rules

- Everyone sharing a database must share `ENCRYPTION_KEY` and `BLIND_INDEX_KEY`. Never generate them per developer against a shared DB.
- Treat `BLIND_INDEX_KEY` as non-rotatable until #320 lands (a versioned index plus duplicate-account detection). In production it is one of the operator-owned GitHub environment secrets (ADR 0001).
- To debug a "no role" login, look for two `users` rows, one pending with a null `workos_user_id`.
