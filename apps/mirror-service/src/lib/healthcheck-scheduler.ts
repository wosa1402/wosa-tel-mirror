import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { TelegramClient } from "telegram";
import { withDbRetry } from "./db-retry";
import { runChannelHealthCheck, type ChannelHealthCheckSettings, type HealthCheckChannelRow } from "./healthcheck";
import { getTelegramErrorMessage } from "./telegram-errors";
import { isChannelInaccessibleError } from "./telegram-metadata";

type SyncEventLevel = (typeof schema.eventLevelEnum.enumValues)[number];

type HealthCheckSchedulerOptions = {
  floodWaitAutoSleepMaxSec: number;
};

type HealthCheckSchedulerDeps = {
  client: TelegramClient;
  settings: ChannelHealthCheckSettings;
  options: HealthCheckSchedulerOptions;
  logSyncEvent: (args: { sourceChannelId: string | null; level: SyncEventLevel; message: string }) => Promise<void>;
};

export function createChannelHealthCheckScheduler({ client, settings, options, logSyncEvent }: HealthCheckSchedulerDeps): {
  ensure: (now: number) => Promise<void>;
} {
  let lastHealthEnsure = 0;
  let lastHealthReloadAt = 0;
  let healthChannels: HealthCheckChannelRow[] = [];
  let healthIndex = 0;

  const reloadHealthChannels = async (): Promise<void> => {
    if (!settings.enabled) return;
    const rows = await withDbRetry(
      () =>
        db
          .select({
            id: schema.sourceChannels.id,
            channelIdentifier: schema.sourceChannels.channelIdentifier,
            telegramId: schema.sourceChannels.telegramId,
            accessHash: schema.sourceChannels.accessHash,
          })
          .from(schema.sourceChannels)
          .where(
            and(
              eq(schema.sourceChannels.isActive, true),
              sql`${schema.sourceChannels.telegramId} is not null`,
              sql`${schema.sourceChannels.accessHash} is not null`,
            ),
          )
          .orderBy(desc(schema.sourceChannels.priority), desc(schema.sourceChannels.subscribedAt)),
      "healthcheck load channels",
      { attempts: 3, baseDelayMs: 250 },
    );

    healthChannels = rows
      .filter((row) => typeof row.telegramId === "bigint" && typeof row.accessHash === "bigint")
      .map((row) => ({
        id: row.id,
        channelIdentifier: row.channelIdentifier,
        telegramId: row.telegramId!,
        accessHash: row.accessHash!,
      }));

    if (healthIndex >= healthChannels.length) healthIndex = 0;
  };

  const ensure = async (now: number): Promise<void> => {
    if (!settings.enabled) return;

    if (now - lastHealthReloadAt > settings.refreshMs || !healthChannels.length) {
      lastHealthReloadAt = now;
      await reloadHealthChannels();
    }

    if (!healthChannels.length) return;
    if (now - lastHealthEnsure < settings.intervalMs) return;
    lastHealthEnsure = now;

    const batch = Math.min(settings.batchSize, healthChannels.length);
    for (let i = 0; i < batch; i += 1) {
      if (!healthChannels.length) return;
      if (healthIndex >= healthChannels.length) healthIndex = 0;
      const channel = healthChannels[healthIndex]!;
      healthIndex += 1;

      try {
        const { recovered, recoveredSyncStatus } = await runChannelHealthCheck(client, channel, {
          floodWaitAutoSleepMaxSec: options.floodWaitAutoSleepMaxSec,
        });

        if (recovered) {
          await logSyncEvent({
            sourceChannelId: channel.id,
            level: "info",
            message: `channel healthcheck recovered (syncStatus=${recoveredSyncStatus})`,
          });
        }
      } catch (error: unknown) {
        const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
        if (!isChannelInaccessibleError(error)) {
          console.warn(`healthcheck failed (ignored): channel=${channel.channelIdentifier} - ${msg}`);
          continue;
        }

        const marked = await withDbRetry(
          () =>
            db
              .update(schema.sourceChannels)
              .set({ syncStatus: "error" })
              .where(and(eq(schema.sourceChannels.id, channel.id), ne(schema.sourceChannels.syncStatus, "error")))
              .returning({ id: schema.sourceChannels.id }),
          `healthcheck mark channel error (channelId=${channel.id})`,
          { attempts: 3, baseDelayMs: 250 },
        );

        if (marked.length) {
          await logSyncEvent({
            sourceChannelId: channel.id,
            level: "error",
            message: `channel healthcheck failed: ${msg}`,
          });
        }
      }
    }
  };

  return { ensure };
}

