import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sourceChannels } from "./source-channels";

export const taskTypeEnum = pgEnum("task_type", [
  "resolve",
  "history_full",
  "history_partial",
  "realtime",
  "retry_failed",
]);
export const taskStatusEnum = pgEnum("task_status", ["pending", "running", "paused", "completed", "failed"]);

export const syncTasks = pgTable(
  "sync_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceChannelId: uuid("source_channel_id")
      .notNull()
      .references(() => sourceChannels.id, { onDelete: "cascade" }),
    taskType: taskTypeEnum("task_type").notNull(),
    status: taskStatusEnum("status").default("pending").notNull(),
    progressCurrent: integer("progress_current").default(0).notNull(),
    progressTotal: integer("progress_total"),
    lastProcessedId: integer("last_processed_id"),
    failedCount: integer("failed_count").default(0).notNull(),
    skippedCount: integer("skipped_count").default(0).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniqueChannelTaskType: uniqueIndex("unique_sync_task_channel_type").on(table.sourceChannelId, table.taskType),
    channelStatusIdx: index("channel_status_idx").on(table.sourceChannelId, table.status),
    statusCreatedIdx: index("status_created_idx").on(table.status, table.createdAt),
  }),
);
