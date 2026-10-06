---
type: Decision
title: "Identity PII is encrypted at rest, while chat and grade content stay plaintext"
description: "Decision 4a: messages.parts and grades feedback/rubric stay plaintext for volume and queryability; student_profiles summary/mastery_signals should be encrypted (accommodations data) but shipped plaintext, tracked as #137."
tags: [security, ferpa, encryption, data-model]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:32:35Z" }
status: stable
governance: constraint
code_refs: [apps/web/src/db/schema/runtime.ts, apps/web/src/db/types/encrypted.ts, apps/web/src/lib/crypto/identity-cipher.ts]
sources:
  - resource: docs/architecture/multi-tenant-data-model.md
  - resource: docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md
---

## Spec proposed
Data-model decision 4 encrypted *identity* PII (email, netid, display name). M2 then added three content-bearing tables with no encryption decision. Review issue #134 recorded the boundary as decision 4a.

## Decision (recorded, partly implemented)
- **`messages.parts` stays plaintext.** It is the richest FERPA-protected content in the system, but write and read volume is very high, it needs to stay queryable for moderation and prompt debugging, and disk-level at-rest encryption covers the raw-exfiltration threat model that `IdentityCipher` targets. The doc names Neon's disk encryption. On AWS that becomes RDS encrypted storage (inferred equivalent).
- **`grades.feedback` / `grades.rubric` stay plaintext.** Re-identification risk is lower, and instructors need to search feedback.
- **`student_profiles.summary` / `mastery_signals` *should* be encrypted.** §3.2 says the table holds accommodations (disability status, extended-time flags), a more sensitive FERPA/ADA class. **They shipped plaintext.** The doc calls this "a real gap, not a considered decision", tracked as #137 (M9). It needs a migration, and `IdentityCipher` handles strings only, not jsonb.

## Implemented
No column-level encryption exists on messages, grades, or student profiles. Identity columns use the `encryptedText` and `blindIndex` custom types (see `requirements/identity-pii-encrypted-at-rest`).

## Revisit trigger
If chat content starts routinely carrying directly identifying strings (a student pasting an SSN), the intended mitigation is the PII-minimization guard (#52), not column encryption. No such guard was found in `apps/web/src` (inferred from a grep).

## Consequences
- Anyone with database read access can read every conversation. Database access control and RDS encryption are the protection.
- Do not put accommodations data into `student_profiles` until #137 is resolved.

# Related Concepts
- [Identity PII is encrypted at rest with AES-256-GCM, and lookups go through HMAC blind indexes](../requirements/identity-pii-encrypted-at-rest.md): What is encrypted and what is not
- [FERPA and HIPAA data-protection items are still open: audit, deletion, retention, and LLM payloads](../requirements/ferpa-data-protection-open-items.md): Open data-protection items
