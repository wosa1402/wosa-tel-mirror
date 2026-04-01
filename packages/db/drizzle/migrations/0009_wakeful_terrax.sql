DROP INDEX "message_edits_mapping_version_idx";--> statement-breakpoint
CREATE INDEX "mirror_channel_idx" ON "message_mappings" USING btree ("mirror_channel_id");