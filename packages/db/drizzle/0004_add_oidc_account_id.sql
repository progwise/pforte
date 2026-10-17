ALTER TABLE "oidc_payloads" ADD COLUMN "account_id" text;--> statement-breakpoint
UPDATE "oidc_payloads" SET "account_id" = "payload"->>'accountId' WHERE "payload"->>'accountId' IS NOT NULL;--> statement-breakpoint
CREATE INDEX "oidc_payloads_account_id" ON "oidc_payloads" USING btree ("account_id");