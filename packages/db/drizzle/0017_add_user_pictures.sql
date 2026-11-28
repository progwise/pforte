CREATE TABLE "user_pictures" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"image" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_pictures_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "picture_key" text;--> statement-breakpoint
ALTER TABLE "user_pictures" ADD CONSTRAINT "user_pictures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_picture_key_unique" UNIQUE("picture_key");