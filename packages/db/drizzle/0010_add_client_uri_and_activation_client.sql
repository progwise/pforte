ALTER TABLE "clients" ADD COLUMN "client_uri" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "activation_client_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_activation_client_id_clients_client_id_fk" FOREIGN KEY ("activation_client_id") REFERENCES "public"."clients"("client_id") ON DELETE set null ON UPDATE no action;