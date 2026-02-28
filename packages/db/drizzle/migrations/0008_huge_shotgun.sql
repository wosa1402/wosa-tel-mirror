CREATE INDEX "sent_channel_message_idx" ON "message_mappings" USING btree ("sent_at","source_channel_id","source_message_id");--> statement-breakpoint
DELETE FROM "sync_tasks"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      row_number() OVER (
        PARTITION BY "source_channel_id", "task_type"
        ORDER BY
          CASE "status"
            WHEN 'running' THEN 1
            WHEN 'pending' THEN 2
            WHEN 'paused' THEN 3
            WHEN 'failed' THEN 4
            WHEN 'completed' THEN 5
            ELSE 6
          END,
          "created_at" DESC,
          "id" DESC
      ) AS rn
    FROM "sync_tasks"
  ) AS ranked
  WHERE ranked.rn > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "unique_sync_task_channel_type" ON "sync_tasks" USING btree ("source_channel_id","task_type");
