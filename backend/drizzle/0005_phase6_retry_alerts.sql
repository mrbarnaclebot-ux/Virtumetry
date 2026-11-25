CREATE TABLE "budget_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_mode" text NOT NULL,
	"budget_window" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"spent" integer NOT NULL,
	"budget" integer NOT NULL,
	"share" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"submission_key" uuid,
	"provider_request_id" text,
	"failure_stage" text,
	"failure_code" text,
	"quoted_credits" integer,
	"client_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "submit_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "world_attempts" ADD CONSTRAINT "world_attempts_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_alerts_window_idx" ON "budget_alerts" USING btree ("provider_mode","budget_window","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "world_attempts_world_attempt_idx" ON "world_attempts" USING btree ("world_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "world_attempts_world_client_idx" ON "world_attempts" USING btree ("world_id","client_request_id");