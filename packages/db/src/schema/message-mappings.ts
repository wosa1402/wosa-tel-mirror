import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { mirrorChannels } from "./mirror-channels";
import { sourceChannels } from "./source-channels";

export const messageStatusEnum = pgEnum("message_status", ["pending", "success", "failed", "skipped"]);
export const messageTypeEnum = pgEnum("message_type", [
  "text",
  "photo",
  "video",
  "document",
  "audio",
  "voice",
  "animation",
  "sticker",
  "other",
]);
export const skipReasonEnum = pgEnum("skip_reason", [
  "protected_content",
  "file_too_large",
  "unsupported_type",
  "rate_limited_skip",
  "failed_too_many_times",
  "message_deleted",
  "filtered",
]);

export const messageMappings = pgTable(
  "message_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceChannelId: uuid("source_channel_id")
      .notNull()
      .references(() => sourceChannels.id, { onDelete: "cascade" }),
    sourceMessageId: integer("source_message_id").notNull(),
    mirrorChannelId: uuid("mirror_channel_id")
      .notNull()
      .references(() => mirrorChannels.id, { onDelete: "cascade" }),
    mirrorMessageId: integer("mirror_message_id"),
    messageType: messageTypeEnum("message_type").notNull(),
    mediaGroupId: text("media_group_id"),
    status: messageStatusEnum("status").default("pending").notNull(),
    skipReason: skipReasonEnum("skip_reason"),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").default(0).notNull(),
    hasMedia: boolean("has_media").default(false).notNull(),
    fileSize: bigint("file_size", { mode: "number" }),
    text: text("text"),
    textPreview: text("text_preview"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    mirroredAt: timestamp("mirrored_at", { withTimezone: true }),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    editCount: integer("edit_count").default(0).notNull(),
    lastEditedAt: timestamp("last_edited_at", { withTimezone: true }),
  },
  (table) => ({
    uniqueSourceMessage: uniqueIndex("unique_source_message").on(table.sourceChannelId, table.sourceMessageId),
    channelSentAtIdx: index("channel_sent_at_idx").on(table.sourceChannelId, table.sentAt),
    sentChannelMessageIdx: index("sent_channel_message_idx").on(table.sentAt, table.sourceChannelId, table.sourceMessageId),
    statusChannelIdx: index("status_channel_idx").on(table.status, table.sourceChannelId),
    mediaGroupIdx: index("media_group_idx").on(table.mediaGroupId),
  }),
);
