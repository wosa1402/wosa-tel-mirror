import { bigint, boolean, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const syncStatusEnum = pgEnum("sync_status", ["pending", "syncing", "completed", "error"]);
export const mirrorModeEnum = pgEnum("mirror_mode", ["forward", "copy"]);
export const messageFilterModeEnum = pgEnum("message_filter_mode", ["inherit", "disabled", "custom"]);

export const sourceChannels = pgTable(
  "source_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupName: text("group_name").default("").notNull(),
    channelIdentifier: text("channel_identifier").notNull(),
    telegramId: bigint("telegram_id", { mode: "bigint" }).unique(),
    accessHash: bigint("access_hash", { mode: "bigint" }),
    name: text("name").notNull(),
    username: text("username"),
    avatarUrl: text("avatar_url"),
    description: text("description"),
    subscribedAt: timestamp("subscribed_at", { withTimezone: true }).defaultNow().notNull(),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    syncStatus: syncStatusEnum("sync_status").default("pending").notNull(),
    lastMessageId: integer("last_message_id"),
    isProtected: boolean("is_protected").default(false).notNull(),
    memberCount: integer("member_count"),
    totalMessages: integer("total_messages"),
    mirrorMode: mirrorModeEnum("mirror_mode").default("forward"),
    isActive: boolean("is_active").default(true).notNull(),
    priority: integer("priority").default(0).notNull(),
    messageFilterMode: messageFilterModeEnum("message_filter_mode").default("inherit").notNull(),
    messageFilterKeywords: text("message_filter_keywords").default("").notNull(),
  },
  (table) => ({
    channelIdentifierIdx: index("source_channels_channel_identifier_idx").on(table.channelIdentifier),
    groupNameIdx: index("source_channels_group_name_idx").on(table.groupName),
    syncStatusIdx: index("source_channels_sync_status_idx").on(table.syncStatus),
  }),
);
