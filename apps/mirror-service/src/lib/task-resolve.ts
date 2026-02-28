import { eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { Api, TelegramClient } from "telegram";
import { toBigIntOrNull } from "./bigint";
import { withDbRetry } from "./db-retry";
import { omitUndefined } from "./omit-undefined";
import { logSyncEvent } from "./sync-events";
import { notifyTasksChanged } from "./tasks-notify";
import { pauseTask } from "./task-lifecycle";
import { getTelegramErrorMessage } from "./telegram-errors";
import {
  buildAutoMirrorTitle,
  ensureAutoChannelAdmins,
  ensureDiscussionGroupForAutoMirrorChannel,
  extractFirstChannelFromUpdates,
  extractInviteLinkFromExportedChatInvite,
} from "./telegram-auto-channel";
import { buildCanonicalChannelIdentifier } from "./telegram-identifiers";
import { getSourceChannelMetadata } from "./telegram-metadata";
import { resolvePeer } from "./telegram-peer";
import { getAutoChannelSettings } from "./settings";

export type ResolveTaskOptions = {
  floodWaitAutoSleepMaxSec: number;
};

export async function processResolveTask(
  client: TelegramClient,
  taskId: string,
  sourceChannelId: string,
  options: ResolveTaskOptions,
): Promise<void> {
  const [source] = await db.select().from(schema.sourceChannels).where(eq(schema.sourceChannels.id, sourceChannelId));
  if (!source) throw new Error(`source channel not found: ${sourceChannelId}`);

  if (!source.isActive) {
    await pauseTask(taskId, "source channel is disabled");
    return;
  }

  console.log(`resolve task start: ${taskId} source=${source.channelIdentifier}`);
  await logSyncEvent({ sourceChannelId: source.id, level: "info", message: `resolve started (taskId=${taskId})` });

  const [mirror] = await db
    .select()
    .from(schema.mirrorChannels)
    .where(eq(schema.mirrorChannels.sourceChannelId, source.id))
    .limit(1);

  const resolvedSource = await resolvePeer(client, source.channelIdentifier);
  if (!resolvedSource.telegramId) throw new Error(`failed to resolve source channel: ${source.channelIdentifier}`);

  const canonicalSourceIdentifier = buildCanonicalChannelIdentifier(resolvedSource, source.channelIdentifier);
  const sourceMetadata = await getSourceChannelMetadata(client, resolvedSource.entity);

  await withDbRetry(
    () =>
      db
        .update(schema.sourceChannels)
        .set(
          omitUndefined({
            channelIdentifier: canonicalSourceIdentifier,
            telegramId: resolvedSource.telegramId,
            accessHash: resolvedSource.accessHash,
            name: resolvedSource.name,
            username: resolvedSource.username,
            syncStatus: "pending",
            description: sourceMetadata.description,
            memberCount: sourceMetadata.memberCount,
            isProtected: sourceMetadata.isProtected,
          }),
        )
        .where(eq(schema.sourceChannels.id, source.id)),
    `resolve update source channel (taskId=${taskId})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  if (mirror) {
    if (mirror.isAutoCreated && !mirror.telegramId) {
      const auto = await getAutoChannelSettings();
      if (!auto.privateChannel) {
        await logSyncEvent({
          sourceChannelId: source.id,
          level: "warn",
          message: "auto_channel_private=false 暂未支持自动创建公开频道，将创建私密频道（无 username）。",
        });
      }

      const title = buildAutoMirrorTitle(auto.prefix, resolvedSource.name || source.channelIdentifier);
      const about = `tg-back mirror for ${canonicalSourceIdentifier}`;

      const created = await client.invoke(
        new Api.channels.CreateChannel({
          broadcast: true,
          title,
          about,
        }),
      );

      const createdChannel = extractFirstChannelFromUpdates(created);
      if (!createdChannel) throw new Error("failed to create mirror channel: no channel entity in updates");

      let inviteLink: string | null = null;
      try {
        const invite = await client.invoke(new Api.messages.ExportChatInvite({ peer: createdChannel }));
        inviteLink = extractInviteLinkFromExportedChatInvite(invite);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        console.warn(`failed to export mirror channel invite link: ${msg}`);
      }

      try {
        await ensureDiscussionGroupForAutoMirrorChannel(
          client,
          {
            sourceChannelId: source.id,
            sourceIdentifier: canonicalSourceIdentifier,
            sourceName: resolvedSource.name || source.channelIdentifier,
            mirrorChannel: createdChannel,
          },
          options,
        );
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        console.warn(`failed to link discussion group: ${msg}`);
        await logSyncEvent({
          sourceChannelId: source.id,
          level: "warn",
          message: `failed to link discussion group: ${msg}`,
        });
      }

      const resolvedMirror = {
        peerType: "channel" as const,
        telegramId: toBigIntOrNull(createdChannel.id),
        accessHash: toBigIntOrNull(createdChannel.accessHash),
        name: createdChannel.title ?? title,
        username: createdChannel.username ?? null,
      };

      if (!resolvedMirror.telegramId) throw new Error("failed to create mirror channel: missing telegram id");

      const canonicalMirrorIdentifier = buildCanonicalChannelIdentifier(
        resolvedMirror,
        `-100${resolvedMirror.telegramId.toString()}`,
      );

      await db
        .update(schema.mirrorChannels)
        .set({
          channelIdentifier: canonicalMirrorIdentifier,
          telegramId: resolvedMirror.telegramId,
          accessHash: resolvedMirror.accessHash,
          name: resolvedMirror.name,
          username: resolvedMirror.username,
          inviteLink,
          isAutoCreated: true,
        })
        .where(eq(schema.mirrorChannels.id, mirror.id));

      console.log(`auto mirror channel created: ${canonicalMirrorIdentifier}`);
      await logSyncEvent({
        sourceChannelId: source.id,
        level: "info",
        message: `auto mirror channel created: ${canonicalMirrorIdentifier}${inviteLink ? ` (invite=${inviteLink})` : ""}`,
      });

      if (auto.admins.length) {
        await ensureAutoChannelAdmins(
          client,
          {
            sourceChannelId: source.id,
            channel: createdChannel,
            channelLabel: `mirror channel ${canonicalMirrorIdentifier}`,
            adminIdentifiers: auto.admins,
          },
          options,
        );
      }
    } else {
      const resolvedMirror = await resolvePeer(client, mirror.channelIdentifier);
      const canonicalMirrorIdentifier = buildCanonicalChannelIdentifier(resolvedMirror, mirror.channelIdentifier);

      if (mirror.isAutoCreated && resolvedMirror.entity instanceof Api.Channel) {
        const auto = await getAutoChannelSettings();
        if (auto.admins.length) {
          await ensureAutoChannelAdmins(
            client,
            {
              sourceChannelId: source.id,
              channel: resolvedMirror.entity,
              channelLabel: `mirror channel ${canonicalMirrorIdentifier}`,
              adminIdentifiers: auto.admins,
            },
            options,
          );
        }

        try {
          await ensureDiscussionGroupForAutoMirrorChannel(
            client,
            {
              sourceChannelId: source.id,
              sourceIdentifier: canonicalSourceIdentifier,
              sourceName: resolvedSource.name || source.channelIdentifier,
              mirrorChannel: resolvedMirror.entity,
            },
            options,
          );
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
          console.warn(`failed to link discussion group: ${msg}`);
          await logSyncEvent({
            sourceChannelId: source.id,
            level: "warn",
            message: `failed to link discussion group: ${msg}`,
          });
        }
      }

      await db
        .update(schema.mirrorChannels)
        .set({
          channelIdentifier: canonicalMirrorIdentifier,
          telegramId: resolvedMirror.telegramId,
          accessHash: resolvedMirror.accessHash,
          name: resolvedMirror.name,
          username: resolvedMirror.username,
        })
        .where(eq(schema.mirrorChannels.id, mirror.id));
    }
  }

  await db
    .update(schema.syncTasks)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(schema.syncTasks.id, taskId));

  void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "resolve", status: "completed" });

  console.log(`resolve task done: ${taskId}`);
  await logSyncEvent({ sourceChannelId: source.id, level: "info", message: `resolve completed (taskId=${taskId})` });
}

