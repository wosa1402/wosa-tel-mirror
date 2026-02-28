import { db, schema } from "@tg-back/db";
import { eq, inArray } from "drizzle-orm";
import { getDbErrorMeta, withDbRetry } from "./db-retry";
import { omitUndefined } from "./omit-undefined";

export type MessageMappingUpdate = Partial<typeof schema.messageMappings.$inferInsert>;

export async function updateMessageMappingsByIds(
  mappingIds: string[],
  set: MessageMappingUpdate,
  context: string,
): Promise<void> {
  if (!mappingIds.length) return;

  const cleanSet = omitUndefined(set);
  if (!Object.keys(cleanSet).length) throw new Error(`updateMessageMappingsByIds called with empty set (${context})`);

  try {
    await withDbRetry(
      () => db.update(schema.messageMappings).set(cleanSet).where(inArray(schema.messageMappings.id, mappingIds)),
      `bulk update message_mappings (${context}, n=${mappingIds.length})`,
      { attempts: 3, baseDelayMs: 250 },
    );
    return;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`bulk update message_mappings failed (${context}, n=${mappingIds.length})${getDbErrorMeta(error)}: ${msg}`);
  }

  let failures = 0;
  for (const id of mappingIds) {
    try {
      await withDbRetry(
        () => db.update(schema.messageMappings).set(cleanSet).where(eq(schema.messageMappings.id, id)),
        `single update message_mappings (${context}, id=${id})`,
        { attempts: 3, baseDelayMs: 250 },
      );
    } catch (error: unknown) {
      failures += 1;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`update message_mappings failed (${context}, id=${id})${getDbErrorMeta(error)}: ${msg}`);
    }
  }

  if (failures) {
    throw new Error(`failed to update message_mappings for ${failures}/${mappingIds.length} rows (${context})`);
  }
}

