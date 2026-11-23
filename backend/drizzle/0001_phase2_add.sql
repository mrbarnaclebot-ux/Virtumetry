CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"event" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worlds" ALTER COLUMN "status" SET DEFAULT 'uploading';--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "manifest_key" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "bundle_key" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "bundle_bytes" bigint;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "image_w" integer;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "image_h" integer;--> statement-breakpoint
ALTER TABLE "credit_events" ADD COLUMN "submission_key" uuid;--> statement-breakpoint
ALTER TABLE "credit_events" ADD COLUMN "kind" text DEFAULT 'reserve' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_events" ADD COLUMN "provider_mode" text DEFAULT 'mock' NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "splat_key" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "collider_key" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "floorplan_key" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "cameras_key" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "thumbnail_key" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "floorplan_meta" jsonb;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "approved_max_credits" integer;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "quoted_credits" integer;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "submission_key" uuid;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "submit_body" jsonb;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "provider_request_id" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "failure_stage" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "failure_message" text;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "charged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_events_submission_kind_idx" ON "credit_events" USING btree ("submission_key","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "worlds_provider_request_idx" ON "worlds" USING btree ("provider_request_id");