ALTER TABLE "share_slugs" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "share_slugs" ADD COLUMN "open_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_slugs" ADD COLUMN "last_opened_at" timestamp with time zone;