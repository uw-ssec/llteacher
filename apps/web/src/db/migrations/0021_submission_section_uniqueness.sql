--> #128: submissions gains the (user_id, section_id) pair it never had, so
--> "one submission per student per section" becomes expressible at all.
-->
--> Hand-written rather than `drizzle-kit generate` output. The generated
--> version was wrong in two ways worth recording, since regenerating it will
--> reproduce both: it emitted `ADD COLUMN ... NOT NULL` with no default and
--> no backfill (fails outright on a non-empty table), and it ordered the
--> composite foreign key BEFORE the conversations unique constraint that FK
--> references (Postgres rejects a foreign key whose target has no matching
--> unique constraint yet).
-->
--> Ordering below is add-nullable -> backfill -> SET NOT NULL -> target
--> constraint -> foreign keys -> unique index, so no step can leave the
--> table half-constrained if the migration stops partway.
ALTER TABLE "submissions" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "section_id" uuid;--> statement-breakpoint

--> Backfill from the owning conversation.
-->
--> #240: `createSubmission` has refused non-section conversations since M2,
--> but the SCHEMA never enforced it -- a submission against a `tutor`
--> conversation (section_id NULL) was insertable, and this repo's own tests
--> were creating exactly that shape until the change this migration belongs
--> to. So the invariant holds for application-written rows only, and an
--> existing database can legitimately violate it. Those rows would backfill
--> to NULL and fail the SET NOT NULL below with an opaque column error.
--> The check below turns that into a message naming the actual problem.
UPDATE "submissions" s
   SET "user_id" = c."owner_user_id",
       "section_id" = c."section_id"
  FROM "conversations" c
 WHERE c."id" = s."conversation_id";--> statement-breakpoint

DO $$
DECLARE orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned FROM "submissions" WHERE "section_id" IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION
      'Migration 0021: % submission row(s) are attached to a non-section conversation and cannot be backfilled. These were insertable before this migration but are not representable after it. Inspect with: SELECT s.id, s.conversation_id, c.kind FROM submissions s JOIN conversations c ON c.id = s.conversation_id WHERE c.section_id IS NULL; then delete or re-point them, and re-run.',
      orphaned;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "submissions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "submissions" ALTER COLUMN "section_id" SET NOT NULL;--> statement-breakpoint

--> Referenceable target for the composite FK. conversations.id is already
--> the primary key, so this weakens nothing and rejects nothing that was
--> previously insertable.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_id_owner_section_uq" UNIQUE("id","owner_user_id","section_id");--> statement-breakpoint

ALTER TABLE "submissions" ADD CONSTRAINT "submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_section_id_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

--> The constraint that keeps the two denormalized columns from drifting from
--> the conversation they describe.
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_conversation_owner_section_fk" FOREIGN KEY ("conversation_id","user_id","section_id") REFERENCES "public"."conversations"("id","owner_user_id","section_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

--> If this statement fails with a uniqueness violation, the database already
--> contains the duplicate #128 describes. Do NOT resolve it by deleting a row
--> here: which of a student's two submissions survives is an instructor's
--> decision, not a migration's. Find them with
-->   SELECT user_id, section_id FROM submissions
-->    GROUP BY 1,2 HAVING count(*) > 1;
--> resolve manually, then re-run. In practice this cannot fire yet -- no
--> route soft-deletes a section conversation, because #27 is not built.
CREATE UNIQUE INDEX "submissions_user_section_uq" ON "submissions" USING btree ("user_id","section_id");
