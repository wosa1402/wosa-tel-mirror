import { db, schema } from "@tg-back/db";

const MAX_EVENT_MESSAGE_LEN = 2_000;

function trimAndTruncateEventMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "(empty)";
  if (trimmed.length <= MAX_EVENT_MESSAGE_LEN) return trimmed;
  return `${trimmed.slice(0, MAX_EVENT_MESSAGE_LEN - 1)}…`;
}

type SyncEventLevel = (typeof schema.eventLevelEnum.enumValues)[number];

export async function logSyncEvent(args: { sourceChannelId: string | null; level: SyncEventLevel; message: string }): Promise<void> {
  try {
    await db.insert(schema.syncEvents).values({
      sourceChannelId: args.sourceChannelId,
      level: args.level,
      message: trimAndTruncateEventMessage(args.message),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to log sync event: ${msg}`);
  }
}

