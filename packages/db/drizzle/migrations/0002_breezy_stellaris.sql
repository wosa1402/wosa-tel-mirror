CREATE TABLE "message_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_mapping_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"previous_text" text,
	"new_text" text,
	"edited_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message_edits" ADD CONSTRAINT "message_edits_message_mapping_id_message_mappings_id_fk" FOREIGN KEY ("message_mapping_id") REFERENCES "public"."message_mappings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_message_edit_version" ON "message_edits" USING btree ("message_mapping_id","version");--> statement-breakpoint
CREATE INDEX "message_edits_mapping_version_idx" ON "message_edits" USING btree ("message_mapping_id","version");