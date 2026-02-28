CREATE INDEX "source_channels_channel_identifier_idx" ON "source_channels" USING btree ("channel_identifier");--> statement-breakpoint
CREATE INDEX "source_channels_group_name_idx" ON "source_channels" USING btree ("group_name");--> statement-breakpoint
CREATE INDEX "source_channels_sync_status_idx" ON "source_channels" USING btree ("sync_status");