---
type: Requirement
title: "FERPA and HIPAA data-protection items are still open: audit, deletion, retention, and LLM payloads"
description: "Open compliance gaps: audit_events append-only only at app layer (#50), student_profiles plaintext (#137), no FERPA hard-delete path, org delete cascades grades/logs/audit, no LLM-payload PII guard (#52), HIPAA tenant unresolved."
tags: [ferpa, hipaa, compliance, security, m9]
generated: { by: "claude-code:claude-opus-5-5", at: "2026-10-06T22:25:30Z" }
status: stable
governance: hold
code_refs: ["apps/web/src/server/repositories/auditEvents.ts", "apps/web/src/db/schema/runtime.ts", "apps/web/src/db/migrations/0036_llm_call_logs_set_null_on_delete.sql", "apps/web/scripts/seed.ts"]
sources:
  - resource: "docs/architecture/multi-tenant-data-model.md"
  - resource: "docs/superpowers/plans/2026-08-03-m2-runtime-persistence.md"
  - resource: "docs/superpowers/plans/2026-06-01-llteacher-platform-generalization.md"
  - resource: ".agents/meeting_ai_at_uw_seed_ai_project_exchange.md"
---

FERPA applies to all four CDI projects. HIPAA applies to Clinical Informatics (data-model §2). The generalization plan's phase 6 also called for a data-flow document, audit logging, deletion and retention policy, BAA review, and a PII scrubber. Milestone M9 (FERPA Compliance & Data Protection, due 2026-09-30) was still open with 11 issues on 2026-10-06. The list below is the state of the code, not a plan.

## Open items
1. **Audit-log immutability.** `audit_events` is append-only only because `repositories/auditEvents.ts` exports just `recordAuditEvent`. No DB trigger was found in `apps/web/src/db/migrations`. A naive "reject UPDATE" trigger would break `actor_user_id ON DELETE SET NULL` survivorship. Tracked as #50.
2. **Accommodations data.** `student_profiles.summary` and `mastery_signals` are plaintext (#137). See `decisions/content-encryption-boundary`.
3. **Hard delete.** There is no FERPA "delete my data" flow (§3.5 Q5). Current FK behavior:
   - `grades.submission_id` is RESTRICT, so a graded student cannot be deleted.
   - `grades.grader_membership_id` is RESTRICT (M2 d14).
   - `llm_call_logs` FKs became SET NULL in migration 0036, because RESTRICT blocked section edits.
4. **Organization deletion cascades silently.** Direct org FKs on `grades` and `llm_call_logs` fire before the submission-level RESTRICT, so `DELETE FROM organizations` wipes grades, LLM logs, and audit events with no gate (M2 d23, confirmed empirically). Retention would need RESTRICT on the org FKs or a soft-delete.
5. **LLM payload PII.** There is no middleware asserting that names or emails never reach the model (#52 intended). OCR also sends scanned course content to the gateway.
6. **HIPAA tenant.** Schema-per-tenant or KMS key custody for Clinical Informatics is undecided. Provider BAAs (OpenRouter vs an enterprise key vs LLMoxie) are unresolved in the repo.
7. **Network egress.** There is no outbound choke point, VPC endpoints, or Flow Logs (deferred, per `infra/README.md`).

## Governance
Status is `hold`. These are acknowledged requirements without a decided implementation. Do not mark them done because the stack deploys. Re-check each against the M9 issues before relying on this list.
