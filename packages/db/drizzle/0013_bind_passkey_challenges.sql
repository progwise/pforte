ALTER TABLE "passkey_challenges" RENAME COLUMN "grant_id" TO "bound_to";--> statement-breakpoint
DROP INDEX "passkey_challenges_user_id";--> statement-breakpoint
ALTER TABLE "passkey_challenges" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "passkey_challenges_bound_to" ON "passkey_challenges" USING btree ("bound_to");