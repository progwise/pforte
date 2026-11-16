CREATE TABLE "passkey_offers" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"bound_to" text NOT NULL,
	"details" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passkey_offers" ADD CONSTRAINT "passkey_offers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkey_offers_user_id" ON "passkey_offers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_offers_expires_at" ON "passkey_offers" USING btree ("expires_at");