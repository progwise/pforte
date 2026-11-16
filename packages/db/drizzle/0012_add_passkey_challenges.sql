CREATE TABLE "passkey_challenges" (
	"challenge" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"grant_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passkey_challenges" ADD CONSTRAINT "passkey_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passkey_challenges_user_id" ON "passkey_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_challenges_expires_at" ON "passkey_challenges" USING btree ("expires_at");