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

--> Backfill from the owning conversation. Every existing submission is
--> against a kind='section' conversation -- createSubmission has required
--> that since M2 -- so section_id is non-null for every row this touches,
--> and the SET NOT NULL below cannot fail on well-formed data.
UPDATE "submissions" s
   SET "user_id" = c."owner_user_id",
       "section_id" = c."section_id"
  FROM "conversations" c
 WHERE c."id" = s."conversation_id";--> statement-breakpoint

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
