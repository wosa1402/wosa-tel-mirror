import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { Api, TelegramClient } from "telegram";
import { returnBigInt } from "telegram/Helpers";
import { sleep } from "../utils/sleep";
import { withDbRetry } from "./db-retry";
import { omitUndefined } from "./omit-undefined";
import { parseFloodWaitSeconds } from "./telegram-errors";
import { extractSourceChannelMetadataFromChatFull } from "./telegram-metadata";

export type ChannelHealthCheckSettings = {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  refreshMs: number;
};

export function getChannelHealthCheckSettings(): ChannelHealthCheckSettings {
  const enabled = process.env.MIRROR_CHANNEL_HEALTHCHECK?.trim() !== "false";

  const intervalSecRaw = Number.parseInt(process.env.MIRROR_CHANNEL_HEALTHCHECK_INTERVAL_SEC ?? "60", 10);
  const intervalSec = Number.isFinite(intervalSecRaw) && intervalSecRaw > 0 ? Math.min(intervalSecRaw, 86_400) : 60;

  const batchRaw = Number.parseInt(process.env.MIRROR_CHANNEL_HEALTHCHECK_BATCH ?? "1", 10);
  const batchSize = Number.isFinite(batchRaw) && batchRaw > 0 ? Math.min(batchRaw, 20) : 1;

  const refreshSecRaw = Number.parseInt(process.env.MIRROR_CHANNEL_HEALTHCHECK_REFRESH_SEC ?? "300", 10);
  const refreshSec = Number.isFinite(refreshSecRaw) && refreshSecRaw > 0 ? Math.min(refreshSecRaw, 86_400) : 300;

  return {
    enabled,
    intervalMs: intervalSec * 1000,
    batchSize,
    refreshMs: refreshSec * 1000,
  };
}

export type HealthCheckChannelRow = {
  id: string;
  channelIdentifier: string;
  telegramId: bigint;
  accessHash: bigint;
};

type RunHealthCheckOptions = {
  floodWaitAutoSleepMaxSec: number;
};

export async function runChannelHealthCheck(
  client: TelegramClient,
  channel: HealthCheckChannelRow,
  options: RunHealthCheckOptions,
): Promise<{
  recovered: boolean;
  recoveredSyncStatus: (typeof schema.syncStatusEnum.enumValues)[number];
}> {
  const input = new Api.InputChannel({
    channelId: returnBigInt(channel.telegramId),
    accessHash: returnBigInt(channel.accessHash),
  });

  const invokeOnce = () => client.invoke(new Api.channels.GetFullChannel({ channel: input }));

  let result: unknown;
  try {
    result = await invokeOnce();
  } catch (error: unknown) {
    const waitSeconds = parseFloodWaitSeconds(error);
    if (waitSeconds && waitSeconds <= options.floodWaitAutoSleepMaxSec) {
      await sleep(waitSeconds * 1000);
      result = await invokeOnce();
    } else {
      throw error;
    }
  }

  const extracted = extractSourceChannelMetadataFromChatFull(result, channel.telegramId);

  await withDbRetry(
    () =>
      db
        .update(schema.sourceChannels)
        .set(
          omitUndefined({
            description: extracted.description,
            memberCount: extracted.memberCount,
            isProtected: extracted.isProtected,
            name: extracted.name,
            username: extracted.username,
            accessHash: extracted.accessHash,
            channelIdentifier: extracted.channelIdentifier,
          }),
        )
        .where(eq(schema.sourceChannels.id, channel.id)),
    `healthcheck update source metadata (channelId=${channel.id})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  const [historyTask] = await withDbRetry(
    () =>
      db
        .select({ status: schema.syncTasks.status })
        .from(schema.syncTasks)
        .where(and(eq(schema.syncTasks.sourceChannelId, channel.id), eq(schema.syncTasks.taskType, "history_full")))
        .orderBy(desc(schema.syncTasks.createdAt))
        .limit(1),
    `healthcheck lookup history_full status (channelId=${channel.id})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  const recoveredSyncStatus: (typeof schema.syncStatusEnum.enumValues)[number] =
    historyTask?.status === "completed"
      ? "completed"
      : historyTask?.status === "running"
        ? "syncing"
        : "pending";

  const recovered = await withDbRetry(
    () =>
      db
        .update(schema.sourceChannels)
        .set({ syncStatus: recoveredSyncStatus })
        .where(and(eq(schema.sourceChannels.id, channel.id), eq(schema.sourceChannels.syncStatus, "error")))
        .returning({ id: schema.sourceChannels.id }),
    `healthcheck recover syncStatus (channelId=${channel.id})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  return { recovered: recovered.length > 0, recoveredSyncStatus };
}

