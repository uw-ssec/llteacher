DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "courses"
    GROUP BY "organization_id", lower(btrim("code")), lower(btrim("term"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'Cannot normalize course identity: duplicate organization/code/term rows differ only by case or surrounding whitespace',
      HINT = 'Rename or consolidate the duplicate course shells, then rerun the migration.';
  END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "courses_org_code_term_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "courses_org_code_term_uq" ON "courses" USING btree ("organization_id",lower(btrim("code")),lower(btrim("term")));
