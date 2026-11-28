ALTER TYPE "public"."otp_purpose" ADD VALUE 'phone_change';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_set_by_user_at" timestamp with time zone;