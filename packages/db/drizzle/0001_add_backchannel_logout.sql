ALTER TABLE "clients" ADD COLUMN "backchannel_logout_uri" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "backchannel_logout_session_required" boolean DEFAULT false NOT NULL;