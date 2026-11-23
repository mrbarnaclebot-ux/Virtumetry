ALTER TABLE "worlds" ADD COLUMN "progress" smallint;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;