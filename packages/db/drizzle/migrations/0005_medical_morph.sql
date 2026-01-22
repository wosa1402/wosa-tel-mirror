CREATE TYPE "public"."message_filter_mode" AS ENUM('inherit', 'disabled', 'custom');--> statement-breakpoint
ALTER TABLE "source_channels" ADD COLUMN "message_filter_mode" "message_filter_mode" DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_channels" ADD COLUMN "message_filter_keywords" text DEFAULT '' NOT NULL;