import { bigint, boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sourceChannels } from "./source-channels";

export const mirrorChannels = pgTable("mirror_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceChannelId: uuid("source_channel_id")
    .notNull()
    .unique()
    .references(() => sourceChannels.id, { onDelete: "cascade" }),
  channelIdentifier: text("channel_identifier").notNull(),
  telegramId: bigint("telegram_id", { mode: "bigint" }),
  accessHash: bigint("access_hash", { mode: "bigint" }),
  name: text("name").notNull(),
  username: text("username"),
  inviteLink: text("invite_link"),
  isAutoCreated: boolean("is_auto_created").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
