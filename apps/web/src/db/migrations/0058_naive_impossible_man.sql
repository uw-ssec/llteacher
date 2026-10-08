DROP INDEX IF EXISTS "organization_credentials_org_provider_label_uq";--> statement-breakpoint
ALTER TABLE "organization_credentials" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_credentials" ADD CONSTRAINT "organization_credentials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_credentials_owner_provider_label_uq" ON "organization_credentials" USING btree ("owner_user_id","provider","label") WHERE "organization_credentials"."owner_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_credentials_legacy_org_provider_label_uq" ON "organization_credentials" USING btree ("organization_id","provider","label") WHERE "organization_credentials"."owner_user_id" IS NULL;
