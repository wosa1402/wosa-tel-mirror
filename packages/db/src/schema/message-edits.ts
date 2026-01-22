import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { messageMappings } from "./message-mappings";

export const messageEdits = pgTable(
  "message_edits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageMappingId: uuid("message_mapping_id")
      .notNull()
      .references(() => messageMappings.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    previousText: text("previous_text"),
    newText: text("new_text"),
    editedAt: timestamp("edited_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    uniqueMappingVersion: uniqueIndex("unique_message_edit_version").on(table.messageMappingId, table.version),
    mappingVersionIdx: index("message_edits_mapping_version_idx").on(table.messageMappingId, table.version),
  }),
);

