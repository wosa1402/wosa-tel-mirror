import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sourceChannels } from "./source-channels";

export const eventLevelEnum = pgEnum("event_level", ["info", "warn", "error"]);

export const syncEvents = pgTable(
  "sync_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceChannelId: uuid("source_channel_id").references(() => sourceChannels.id, { onDelete: "cascade" }),
    level: eventLevelEnum("level").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    channelCreatedIdx: index("event_channel_created_idx").on(table.sourceChannelId, table.createdAt),
  }),
);

