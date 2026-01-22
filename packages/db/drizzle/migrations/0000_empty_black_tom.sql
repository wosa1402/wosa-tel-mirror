CREATE TYPE "public"."mirror_mode" AS ENUM('forward', 'copy');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('pending', 'syncing', 'completed', 'error');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('pending', 'success', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'photo', 'video', 'document', 'audio', 'voice', 'animation', 'sticker', 'other');--> statement-breakpoint
CREATE TYPE "public"."skip_reason" AS ENUM('protected_content', 'file_too_large', 'unsupported_type', 'rate_limited_skip', 'failed_too_many_times', 'message_deleted');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'running', 'paused', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('resolve', 'history_full', 'history_partial', 'realtime', 'retry_failed');--> statement-breakpoint
CREATE TYPE "public"."event_level" AS ENUM('info', 'warn', 'error');--> statement-breakpoint
CREATE TABLE "source_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_identifier" text NOT NULL,
	"telegram_id" bigint,
	"access_hash" bigint,
	"name" text NOT NULL,
	"username" text,
	"avatar_url" text,
	"description" text,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"sync_status" "sync_status" DEFAULT 'pending' NOT NULL,
	"last_message_id" integer,
	"is_protected" boolean DEFAULT false NOT NULL,
	"member_count" integer,
	"total_messages" integer,
	"mirror_mode" "mirror_mode" DEFAULT 'copy',
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "source_channels_telegram_id_unique" UNIQUE("telegram_id")
);
--> statement-breakpoint
CREATE TABLE "mirror_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"telegram_id" bigint NOT NULL,
	"access_hash" bigint,
	"name" text NOT NULL,
	"username" text,
	"invite_link" text,
	"is_auto_created" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mirror_channels_source_channel_id_unique" UNIQUE("source_channel_id")
);
--> statement-breakpoint
CREATE TABLE "message_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"source_message_id" integer NOT NULL,
	"mirror_channel_id" uuid NOT NULL,
	"mirror_message_id" integer,
	"message_type" "message_type" NOT NULL,
	"media_group_id" text,
	"status" "message_status" DEFAULT 'pending' NOT NULL,
	"skip_reason" "skip_reason",
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"has_media" boolean DEFAULT false NOT NULL,
	"file_size" bigint,
	"text" text,
	"text_preview" text,
	"sent_at" timestamp with time zone NOT NULL,
	"mirrored_at" timestamp with time zone,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"edit_count" integer DEFAULT 0 NOT NULL,
	"last_edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_channel_id" uuid NOT NULL,
	"task_type" "task_type" NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"progress_current" integer DEFAULT 0 NOT NULL,
	"progress_total" integer,
	"last_processed_id" integer,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_channel_id" uuid,
	"level" "event_level" NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
ALTER TABLE "mirror_channels" ADD CONSTRAINT "mirror_channels_source_channel_id_source_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."source_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mappings" ADD CONSTRAINT "message_mappings_source_channel_id_source_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."source_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mappings" ADD CONSTRAINT "message_mappings_mirror_channel_id_mirror_channels_id_fk" FOREIGN KEY ("mirror_channel_id") REFERENCES "public"."mirror_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_tasks" ADD CONSTRAINT "sync_tasks_source_channel_id_source_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."source_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_events" ADD CONSTRAINT "sync_events_source_channel_id_source_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."source_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_source_message" ON "message_mappings" USING btree ("source_channel_id","source_message_id");--> statement-breakpoint
CREATE INDEX "channel_sent_at_idx" ON "message_mappings" USING btree ("source_channel_id","sent_at");--> statement-breakpoint
CREATE INDEX "status_channel_idx" ON "message_mappings" USING btree ("status","source_channel_id");--> statement-breakpoint
CREATE INDEX "media_group_idx" ON "message_mappings" USING btree ("media_group_id");--> statement-breakpoint
CREATE INDEX "channel_status_idx" ON "sync_tasks" USING btree ("source_channel_id","status");--> statement-breakpoint
CREATE INDEX "status_created_idx" ON "sync_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "event_channel_created_idx" ON "sync_events" USING btree ("source_channel_id","created_at");
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS message_mappings_text_trgm_idx ON message_mappings USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS message_mappings_cursor_idx ON message_mappings (source_channel_id, sent_at DESC, source_message_id DESC);
