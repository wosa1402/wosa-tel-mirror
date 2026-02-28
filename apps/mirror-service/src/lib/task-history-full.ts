import { and, eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { Api, TelegramClient } from "telegram";
import { sleep } from "../utils/sleep";
import { withDbRetry } from "./db-retry";
import { updateMessageMappingsByIds } from "./message-mappings";
import { classifyMirrorError, extractMediaFileSize, messageTypeFromMessage } from "./mirror-message";
import { logSyncEvent } from "./sync-events";
import { pauseTask } from "./task-lifecycle";
import { notifyTasksChanged } from "./tasks-notify";
import { getTelegramErrorMessage, parseFloodWaitSeconds } from "./telegram-errors";
import { forwardMessagesAsCopy } from "./telegram-forward";
import { ensureAutoChannelAdmins, ensureDiscussionGroupForAutoMirrorChannel } from "./telegram-auto-channel";
import { ensureOriginalLinkComment as ensureOriginalLinkCommentImpl } from "./telegram-original-link";
import { resolvePeer } from "./telegram-peer";
import { ensureMirrorMessageSpoiler as ensureMirrorMessageSpoilerImpl } from "./telegram-spoiler";
import { buildSourceMessageLink } from "./telegram-identifiers";
import { getLinkedDiscussionChatFilter } from "./telegram-metadata";
import {
  getAutoChannelSettings,
  getEffectiveMessageFilterSettings,
  getMirrorBehaviorSettings,
  shouldSkipMessageByFilter,
  throttleMirrorSend,
} from "./settings";
import { syncCommentsForPost as syncCommentsForPostImpl } from "./telegram-comments";

export type HistoryFullTaskOptions = {
  floodWaitAutoSleepMaxSec: number;
};

export async function processHistoryFullTask(
  client: TelegramClient,
  taskId: string,
  sourceChannelId: string,
  options: HistoryFullTaskOptions,
): Promise<void> {
  const FLOOD_WAIT_AUTO_SLEEP_MAX_SEC = options.floodWaitAutoSleepMaxSec;

  const ensureMirrorMessageSpoiler = (
    client: TelegramClient,
    args: {
      mirrorPeer: unknown;
      mirrorMessageId: number;
      sourceMessage: Api.Message;
      mirroredMessage?: Api.Message | null;
    },
  ): Promise<void> =>
    ensureMirrorMessageSpoilerImpl(client, args, { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC });

  const ensureOriginalLinkComment = (
    client: TelegramClient,
    args: { mirrorEntity: unknown; mirrorChannelId: string; mirrorPostId: number; sourceLink: string | null },
  ): Promise<void> =>
    ensureOriginalLinkCommentImpl(client, args, { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC });

  const syncCommentsForPost = (
    client: TelegramClient,
    args: {
      sourceEntity: unknown;
      mirrorEntity: unknown;
      mirrorChannelId: string;
      sourceChannel: { username?: string | null; telegramId?: bigint | null };
      sourcePostId: number;
      mirrorPostId: number;
      maxComments: number;
    },
  ): Promise<void> =>
    syncCommentsForPostImpl(client, args, { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC });
  const [task] = await db.select().from(schema.syncTasks).where(eq(schema.syncTasks.id, taskId)).limit(1);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const [source] = await db.select().from(schema.sourceChannels).where(eq(schema.sourceChannels.id, sourceChannelId));
  if (!source) throw new Error(`source channel not found: ${sourceChannelId}`);

  if (!source.isActive) {
    await pauseTask(taskId, "source channel is disabled");
    return;
  }

  const [mirror] = await db
    .select()
    .from(schema.mirrorChannels)
    .where(eq(schema.mirrorChannels.sourceChannelId, source.id))
    .limit(1);
  if (!mirror) throw new Error(`mirror channel not found for source: ${source.id}`);

  if (!source.telegramId) throw new Error(`source channel not resolved yet: ${source.channelIdentifier}`);

  const mode = source.mirrorMode ?? "forward";
  console.log(`history_full task start: ${taskId} source=${source.channelIdentifier} mode=${mode}`);

  await withDbRetry(
    () =>
      db
        .update(schema.sourceChannels)
        .set({ syncStatus: "syncing" })
        .where(eq(schema.sourceChannels.id, source.id)),
    `history_full mark source syncing (taskId=${taskId})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  await logSyncEvent({
    sourceChannelId: source.id,
    level: "info",
    message: `history_full started mode=${mode} (taskId=${taskId}) resumeFromId=${task.lastProcessedId ?? 0} progress=${task.progressCurrent ?? 0}/${task.progressTotal ?? "-"}`,
  });

  const sourceEntity = (await resolvePeer(client, source.channelIdentifier)).entity;
  const mirrorEntity = (await resolvePeer(client, mirror.channelIdentifier)).entity;

  if (mirror.isAutoCreated && mirrorEntity instanceof Api.Channel) {
    const auto = await getAutoChannelSettings();
    if (auto.admins.length) {
      await ensureAutoChannelAdmins(
        client,
        {
          sourceChannelId: source.id,
          channel: mirrorEntity,
          channelLabel: `mirror channel ${mirror.channelIdentifier}`,
          adminIdentifiers: auto.admins,
        },
        { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC },
      );
    }
  }

  const mirrorBehavior = await getMirrorBehaviorSettings();

  const syncCommentsEnabled = process.env.MIRROR_SYNC_COMMENTS?.trim() !== "false";
  const maxCommentsPerPostRaw = Number.parseInt(process.env.MIRROR_MAX_COMMENTS_PER_POST ?? "500", 10);
  const maxCommentsPerPost =
    Number.isFinite(maxCommentsPerPostRaw) && maxCommentsPerPostRaw > 0 ? Math.min(maxCommentsPerPostRaw, 10_000) : 500;

  const sourceDiscussionChatFilter = syncCommentsEnabled ? await getLinkedDiscussionChatFilter(client, sourceEntity) : null;
  let mirrorDiscussionChatFilter = syncCommentsEnabled ? await getLinkedDiscussionChatFilter(client, mirrorEntity) : null;

  if (syncCommentsEnabled && !mirrorDiscussionChatFilter && mirror.isAutoCreated && mirrorEntity instanceof Api.Channel) {
    try {
      mirrorDiscussionChatFilter = await ensureDiscussionGroupForAutoMirrorChannel(
        client,
        {
          sourceChannelId: source.id,
          sourceIdentifier: source.channelIdentifier,
          sourceName: source.name || source.channelIdentifier,
          mirrorChannel: mirrorEntity,
        },
        { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC },
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

  const canPostOriginalLinkComment = syncCommentsEnabled && !!mirrorDiscussionChatFilter;

  const canSyncComments =
    syncCommentsEnabled && !!sourceDiscussionChatFilter && !!mirrorDiscussionChatFilter && maxCommentsPerPost > 0;

  let reportedProtectedContent = false;

  console.log(
    `history_full task resume: ${taskId} lastProcessedId=${task.lastProcessedId ?? 0} progress=${task.progressCurrent ?? 0}/${task.progressTotal ?? "-"}`,
  );

  if (!task.startedAt) {
    await withDbRetry(
      () => db.update(schema.syncTasks).set({ startedAt: new Date() }).where(eq(schema.syncTasks.id, taskId)),
      `history_full set started_at (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
    void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "history_full", status: "running" });
  }

  let progressTotal: number | null = task.progressTotal ?? null;

  if (
    typeof progressTotal === "number" &&
    Number.isFinite(progressTotal) &&
    progressTotal > 0 &&
    (source.totalMessages == null || source.totalMessages !== progressTotal)
  ) {
    await withDbRetry(
      () => db.update(schema.sourceChannels).set({ totalMessages: progressTotal }).where(eq(schema.sourceChannels.id, source.id)),
      `history_full sync source total_messages (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
  }

  if (!task.progressTotal) {
    try {
      const list = await client.getMessages(sourceEntity, { limit: 0 });
      const totalRaw = (list as unknown as { total?: unknown }).total;
      const total = typeof totalRaw === "number" ? totalRaw : null;
      if (total && Number.isFinite(total)) {
        progressTotal = total;
        await withDbRetry(
          () => db.update(schema.syncTasks).set({ progressTotal }).where(eq(schema.syncTasks.id, taskId)),
          `history_full set progress_total (taskId=${taskId})`,
          { attempts: 3, baseDelayMs: 250 },
        );
        void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "history_full" });
        await withDbRetry(
          () => db.update(schema.sourceChannels).set({ totalMessages: progressTotal }).where(eq(schema.sourceChannels.id, source.id)),
          `history_full set source total_messages (taskId=${taskId})`,
          { attempts: 3, baseDelayMs: 250 },
        );
      }
    } catch (error: unknown) {
      const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
      console.warn(`history_full failed to fetch progress_total (taskId=${taskId}): ${msg}`);
    }
  }

  let snapshotLatestId: number | null = null;
  let snapshotLatestIdFetchFailed = false;
  try {
    const latestList = await client.getMessages(sourceEntity, { limit: 1 });
    const latest = Array.isArray(latestList) ? latestList[0] : null;
    if (latest instanceof Api.Message && typeof latest.id === "number" && latest.id > 0) {
      snapshotLatestId = latest.id;
      console.log(`history_full snapshot latest source message id: ${snapshotLatestId}`);
      await logSyncEvent({
        sourceChannelId: source.id,
        level: "info",
        message: `history_full snapshot latestId=${snapshotLatestId} (taskId=${taskId})`,
      });
    }
  } catch (error: unknown) {
    snapshotLatestIdFetchFailed = true;
    const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
    console.warn(`failed to fetch history_full snapshot latest message id: ${msg}`);
    await logSyncEvent({
      sourceChannelId: source.id,
      level: "warn",
      message: `failed to fetch history_full snapshot latest message id: ${msg} (taskId=${taskId})`,
    });
  }

  let progressCurrent = task.progressCurrent ?? 0;
  let lastProcessedId = task.lastProcessedId ?? 0;

  let lastProgressLogAt = Date.now();
  let lastProgressLogValue = progressCurrent;

  let lastActiveCheckAt = 0;
  let lastActiveValue = true;

  const ensureActiveOrPause = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - lastActiveCheckAt < 5_000) return lastActiveValue;
    lastActiveCheckAt = now;

    try {
      const [taskRow] = await db
        .select({ status: schema.syncTasks.status })
        .from(schema.syncTasks)
        .where(eq(schema.syncTasks.id, taskId))
        .limit(1);
      const status = taskRow?.status ?? null;
      if (status === "paused" || status === "failed" || status === "completed") {
        lastActiveValue = false;
        await persistProgress();
        return false;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`failed to check task status: ${msg}`);
    }

    try {
      const [row] = await db
        .select({ isActive: schema.sourceChannels.isActive })
        .from(schema.sourceChannels)
        .where(eq(schema.sourceChannels.id, source.id))
        .limit(1);
      lastActiveValue = !!row?.isActive;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`failed to check channel active: ${msg}`);
      lastActiveValue = true;
    }

    if (!lastActiveValue) {
      await pauseTask(taskId, "paused by user", { progressCurrent, progressTotal, lastProcessedId });
      return false;
    }

    return true;
  };

  const logProgressIfNeeded = () => {
    const now = Date.now();
    if (now - lastProgressLogAt < 15_000 && progressCurrent - lastProgressLogValue < 200) return;
    lastProgressLogAt = now;
    lastProgressLogValue = progressCurrent;
    console.log(
      `history_full progress: ${taskId} ${progressCurrent}/${progressTotal ?? "-"} lastProcessedId=${lastProcessedId}`,
    );
  };

  let lastPersistAt = Date.now();
  let lastPersistedProgress = progressCurrent;
  let lastPersistedProcessedId = lastProcessedId;

  const persistProgress = async () => {
    const now = Date.now();
    if (now - lastPersistAt < 2_000 && progressCurrent - lastPersistedProgress < 50) return;
    await withDbRetry(
      () => db.update(schema.syncTasks).set({ progressCurrent, lastProcessedId }).where(eq(schema.syncTasks.id, taskId)),
      `history_full persist progress (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
    void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "history_full" });
    lastPersistAt = now;
    lastPersistedProgress = progressCurrent;
    lastPersistedProcessedId = lastProcessedId;
  };

  type PendingHistoryItem = { msg: Api.Message; mappingId: string };

  let pending: PendingHistoryItem[] = [];
  let pendingGroupId: string | null = null;

  const advanceProgressFor = async (msgId: number) => {
    lastProcessedId = msgId;
    progressCurrent += 1;
    await persistProgress();
    logProgressIfNeeded();
  };

  const flushPending = async (): Promise<"ok" | "paused"> => {
    if (!pending.length) return "ok";

    if (!(await ensureActiveOrPause())) return "paused";

    const items = [...pending].sort((a, b) => a.msg.id - b.msg.id);
    pending = [];
    pendingGroupId = null;

    const messageIds = items.map((i) => i.msg.id);
    const mappingIds = items.map((i) => i.mappingId);

    const messageFilter = await getEffectiveMessageFilterSettings(source.id);
    const shouldFilter =
      messageFilter.enabled &&
      messageFilter.keywords.length > 0 &&
      items.some((item) => shouldSkipMessageByFilter(typeof item.msg.message === "string" ? item.msg.message : "", messageFilter));

    if (shouldFilter) {
      await updateMessageMappingsByIds(
        mappingIds,
        { status: "skipped", skipReason: "filtered", mirroredAt: new Date(), errorMessage: null },
        "history_full skip:filtered",
      );
    } else if (mode === "forward") {
      const tryForwardOnce = async () =>
        await forwardMessagesAsCopy(client, { fromPeer: sourceEntity, toPeer: mirrorEntity, messageIds });

      let forwarded: (Api.Message | undefined)[] | null = null;
      for (;;) {
        try {
          forwarded = await tryForwardOnce();
          break;
        } catch (error: unknown) {
          const { skipReason } = classifyMirrorError(error);
          if (skipReason) {
            if (skipReason === "protected_content" && !reportedProtectedContent) {
              reportedProtectedContent = true;
              console.warn(
                `source channel has protected content enabled; Telegram blocks forwarding. Messages will be marked skipped (or task paused if skip_protected_content=false) and will not appear in the mirror channel.`,
              );
              await logSyncEvent({
                sourceChannelId: source.id,
                level: "warn",
                message: `protected content enabled; history_full forwarding blocked (taskId=${taskId})`,
              });
            }

            if (skipReason === "protected_content" && !source.isProtected) {
              try {
                await db.update(schema.sourceChannels).set({ isProtected: true }).where(eq(schema.sourceChannels.id, source.id));
                source.isProtected = true;
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn(`failed to mark source channel protected: ${source.id} - ${msg}`);
              }
            }

            if (skipReason === "protected_content" && !mirrorBehavior.skipProtectedContent) {
              const msg0 = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
              await updateMessageMappingsByIds(
                mappingIds,
                { status: "failed", skipReason: "protected_content", errorMessage: msg0, mirroredAt: new Date() },
                "history_full protected_content blocked",
              );
              await pauseTask(taskId, msg0, { progressCurrent, progressTotal, lastProcessedId });
              return "paused";
            }

            await updateMessageMappingsByIds(
              mappingIds,
              { status: "skipped", skipReason, mirroredAt: new Date(), errorMessage: null },
              `history_full skip:${skipReason}`,
            );
            forwarded = null;
            break;
          }

          const waitSeconds = parseFloodWaitSeconds(error);
          if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
            await sleep((waitSeconds + 1) * 1000);
            if (!(await ensureActiveOrPause())) return "paused";
            continue;
          }

          const msg1 = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
          await updateMessageMappingsByIds(
            mappingIds,
            { status: "failed", errorMessage: msg1, mirroredAt: new Date() },
            "history_full forward failed",
          );
          await pauseTask(taskId, msg1, { progressCurrent, progressTotal, lastProcessedId });
          return "paused";
        }
      }

      if (forwarded) {
        await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);

        let hasFailure = false;

        for (let i = 0; i < items.length; i += 1) {
          const mirrorMessageId = forwarded[i]?.id ?? null;
          if (mirrorMessageId == null) {
            hasFailure = true;
            await withDbRetry(
              () =>
                db
                  .update(schema.messageMappings)
                  .set({ status: "failed", errorMessage: "missing forwarded message mapping", mirroredAt: new Date() })
                  .where(eq(schema.messageMappings.id, items[i]!.mappingId)),
              `history_full mark failed (taskId=${taskId})`,
              { attempts: 3, baseDelayMs: 250 },
            );
          } else {
            await withDbRetry(
              () =>
                db
                  .update(schema.messageMappings)
                  .set({ status: "success", mirrorMessageId, mirroredAt: new Date(), errorMessage: null })
                  .where(eq(schema.messageMappings.id, items[i]!.mappingId)),
              `history_full mark success (taskId=${taskId})`,
              { attempts: 3, baseDelayMs: 250 },
            );
          }
        }

        if (hasFailure) {
          await pauseTask(taskId, "missing forwarded message mapping", { progressCurrent, progressTotal, lastProcessedId });
          return "paused";
        }

        for (let i = 0; i < items.length; i += 1) {
          const mirrorMessageId = forwarded[i]?.id ?? null;
          if (!mirrorMessageId) continue;
          await ensureMirrorMessageSpoiler(client, {
            mirrorPeer: mirrorEntity,
            mirrorMessageId,
            sourceMessage: items[i]!.msg,
            mirroredMessage: forwarded[i] ?? null,
          });
        }

        await withDbRetry(
          () =>
            db
              .update(schema.sourceChannels)
              .set({ lastSyncAt: new Date(), lastMessageId: messageIds[messageIds.length - 1] })
              .where(eq(schema.sourceChannels.id, source.id)),
          `history_full update source last_sync_at (taskId=${taskId})`,
          { attempts: 3, baseDelayMs: 250 },
        );

        if (canPostOriginalLinkComment) {
          const anchor = items[0]?.msg;
          const mirrorPostId = forwarded[0]?.id;
          if (anchor?.post && mirrorPostId) {
            const link = buildSourceMessageLink(source, anchor.id);
            await ensureOriginalLinkComment(client, { mirrorEntity, mirrorChannelId: mirror.id, mirrorPostId, sourceLink: link });
          }
        }

        if (canSyncComments) {
          for (let i = 0; i < items.length; i += 1) {
            const mirrorPostId = forwarded[i]?.id;
            const replies = items[i]!.msg.replies;
            if (!mirrorPostId) continue;
            if (!items[i]!.msg.post) continue;
            if (!(replies instanceof Api.MessageReplies) || replies.replies <= 0) continue;
            await syncCommentsForPost(client, {
              sourceEntity,
              mirrorEntity,
              mirrorChannelId: mirror.id,
              sourceChannel: source,
              sourcePostId: items[i]!.msg.id,
              mirrorPostId,
              maxComments: maxCommentsPerPost,
            });
          }
        }
      }
    } else {
      for (const item of items) {
        const msg = item.msg;
        const text = typeof msg.message === "string" ? msg.message : "";
        const content = text.trim();

        if (!content) {
          await withDbRetry(
            () =>
              db
                .update(schema.messageMappings)
                .set({ status: "skipped", skipReason: "unsupported_type", mirroredAt: new Date(), errorMessage: null })
                .where(eq(schema.messageMappings.id, item.mappingId)),
            `history_full copy skip unsupported (taskId=${taskId})`,
            { attempts: 3, baseDelayMs: 250 },
          );
          await advanceProgressFor(msg.id);
          continue;
        }

	        try {
	          const sent = await client.sendMessage(mirrorEntity, { message: content });
	          await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);
	          await withDbRetry(
	            () =>
	              db
	                .update(schema.messageMappings)
                .set({ status: "success", mirrorMessageId: sent?.id ?? null, mirroredAt: new Date(), errorMessage: null })
                .where(eq(schema.messageMappings.id, item.mappingId)),
            `history_full copy mark success (taskId=${taskId})`,
            { attempts: 3, baseDelayMs: 250 },
          );

          await withDbRetry(
            () =>
              db
                .update(schema.sourceChannels)
                .set({ lastSyncAt: new Date(), lastMessageId: msg.id })
                .where(eq(schema.sourceChannels.id, source.id)),
            `history_full copy update source last_sync_at (taskId=${taskId})`,
            { attempts: 3, baseDelayMs: 250 },
          );

          if (canPostOriginalLinkComment && sent?.id && msg.post) {
            const link = buildSourceMessageLink(source, msg.id);
            await ensureOriginalLinkComment(client, {
              mirrorEntity,
              mirrorChannelId: mirror.id,
              mirrorPostId: sent.id,
              sourceLink: link,
            });
          }

          if (canSyncComments && sent?.id && msg.post && msg.replies instanceof Api.MessageReplies && msg.replies.replies > 0) {
		            await syncCommentsForPost(client, {
		              sourceEntity,
		              mirrorEntity,
	              mirrorChannelId: mirror.id,
	              sourceChannel: source,
	              sourcePostId: msg.id,
	              mirrorPostId: sent.id,
	              maxComments: maxCommentsPerPost,
	            });
          }
	        } catch (error: unknown) {
	          const { skipReason } = classifyMirrorError(error);
	          if (skipReason) {
	            await withDbRetry(
              () =>
                db
                  .update(schema.messageMappings)
                  .set({ status: "skipped", skipReason, mirroredAt: new Date(), errorMessage: null })
                  .where(eq(schema.messageMappings.id, item.mappingId)),
              `history_full copy mark skipped (taskId=${taskId})`,
              { attempts: 3, baseDelayMs: 250 },
            );
	          } else {
	            const waitSeconds = parseFloodWaitSeconds(error);
	            if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
	              await sleep((waitSeconds + 1) * 1000);
	              if (!(await ensureActiveOrPause())) return "paused";
	              try {
	                const sent = await client.sendMessage(mirrorEntity, { message: content });
	                await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);
	                await withDbRetry(
	                  () =>
	                    db
	                      .update(schema.messageMappings)
	                      .set({ status: "success", mirrorMessageId: sent?.id ?? null, mirroredAt: new Date(), errorMessage: null })
	                      .where(eq(schema.messageMappings.id, item.mappingId)),
	                  `history_full copy mark success (taskId=${taskId})`,
	                  { attempts: 3, baseDelayMs: 250 },
	                );
	              } catch (error2: unknown) {
	                const msg2 = error2 instanceof Error ? error2.message : getTelegramErrorMessage(error2) ?? String(error2);
	                await withDbRetry(
	                  () =>
	                    db
	                      .update(schema.messageMappings)
	                      .set({ status: "failed", errorMessage: msg2, mirroredAt: new Date() })
	                      .where(eq(schema.messageMappings.id, item.mappingId)),
	                  `history_full copy mark failed (taskId=${taskId})`,
	                  { attempts: 3, baseDelayMs: 250 },
	                );
	                await pauseTask(taskId, msg2, { progressCurrent, progressTotal, lastProcessedId });
	                return "paused";
	              }
	            } else {
	              const msg1 = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
	              await withDbRetry(
	                () =>
	                  db
	                    .update(schema.messageMappings)
	                    .set({ status: "failed", errorMessage: msg1, mirroredAt: new Date() })
	                    .where(eq(schema.messageMappings.id, item.mappingId)),
	                `history_full copy mark failed (taskId=${taskId})`,
	                { attempts: 3, baseDelayMs: 250 },
	              );
	              await pauseTask(taskId, msg1, { progressCurrent, progressTotal, lastProcessedId });
	              return "paused";
	            }
	          }
	        }

	        await advanceProgressFor(msg.id);
      }

      return "ok";
    }

    for (const item of items) {
      await advanceProgressFor(item.msg.id);
    }

    return "ok";
  };

  let lastUnexpectedEndAt = 0;
  let noProgressRounds = 0;

  for (;;) {
    const roundStartedAt = Date.now();
    const roundStartProgress = progressCurrent;
    const roundStartLastId = lastProcessedId;

    for await (const msg of client.iterMessages(sourceEntity, { reverse: true, minId: lastProcessedId, waitTime: 1 })) {
      if (!(await ensureActiveOrPause())) return;
      if (!(msg instanceof Api.Message)) continue;
      if (!msg.id) continue;
      if (lastProcessedId && msg.id <= lastProcessedId) continue;

      const groupId = mode === "forward" && mirrorBehavior.groupMediaMessages && msg.groupedId ? String(msg.groupedId) : null;
      if (pending.length && pendingGroupId !== groupId) {
        const result = await flushPending();
        if (result === "paused") return;
      }

      const sentAt = new Date(msg.date * 1000);
      const text = typeof msg.message === "string" ? msg.message : "";
      const textPreview = text.length > 200 ? `${text.slice(0, 200)}` : text;
      const messageType = messageTypeFromMessage(msg);
      const mediaGroupId = msg.groupedId ? String(msg.groupedId) : null;
      const hasMedia = !!msg.media;
      const fileSize = extractMediaFileSize(msg);

      let status: (typeof schema.messageStatusEnum.enumValues)[number] = "pending";
      let skipReason: (typeof schema.skipReasonEnum.enumValues)[number] | null = null;
      let errorMessage: string | null = null;
      let mirroredAt: Date | null = null;

      if (hasMedia) {
        if (messageType === "video" && !mirrorBehavior.mirrorVideos) {
          status = "skipped";
          skipReason = "unsupported_type";
          errorMessage = "skipped: video disabled by settings";
          mirroredAt = new Date();
        } else if (
          mirrorBehavior.maxFileSizeBytes != null &&
          fileSize != null &&
          Number.isFinite(fileSize) &&
          fileSize > mirrorBehavior.maxFileSizeBytes
        ) {
          status = "skipped";
          skipReason = "file_too_large";
          errorMessage = `skipped: file too large (${Math.ceil(fileSize / 1024 / 1024)}MB > ${mirrorBehavior.maxFileSizeMb}MB)`;
          mirroredAt = new Date();
        }
      }

      const inserted = await withDbRetry(
        () =>
          db
            .insert(schema.messageMappings)
            .values({
              sourceChannelId: source.id,
              sourceMessageId: msg.id,
              mirrorChannelId: mirror.id,
              messageType,
              mediaGroupId,
              status,
              skipReason,
              errorMessage,
              hasMedia,
              fileSize: fileSize ?? null,
              text: text || null,
              textPreview: textPreview || null,
              sentAt,
              mirroredAt,
            })
            .onConflictDoNothing()
            .returning({ id: schema.messageMappings.id, status: schema.messageMappings.status }),
        `history_full upsert message_mapping (taskId=${taskId}, msgId=${msg.id})`,
        { attempts: 3, baseDelayMs: 250 },
      );

      let mappingId: string | null = inserted[0]?.id ?? null;
      let mappingStatus: (typeof schema.messageStatusEnum.enumValues)[number] | null = inserted[0]?.status ?? null;

      if (!mappingId) {
        const [existing] = await withDbRetry(
          () =>
            db
              .select({ id: schema.messageMappings.id, status: schema.messageMappings.status })
              .from(schema.messageMappings)
              .where(and(eq(schema.messageMappings.sourceChannelId, source.id), eq(schema.messageMappings.sourceMessageId, msg.id)))
              .limit(1),
          `history_full lookup message_mapping (taskId=${taskId}, msgId=${msg.id})`,
          { attempts: 3, baseDelayMs: 250 },
        );
        mappingId = existing?.id ?? null;
        mappingStatus = existing?.status ?? null;
      }

      if (!mappingId || !mappingStatus) {
        await advanceProgressFor(msg.id);
        continue;
      }

      if (mappingStatus === "success" || mappingStatus === "skipped") {
        await advanceProgressFor(msg.id);
        continue;
      }

      pendingGroupId = groupId;
      pending.push({ msg, mappingId });

      if (!groupId) {
        const result = await flushPending();
        if (result === "paused") return;
      }
    }

    const finalResult = await flushPending();
    if (finalResult === "paused") return;

    await withDbRetry(
      () => db.update(schema.syncTasks).set({ progressCurrent, lastProcessedId }).where(eq(schema.syncTasks.id, taskId)),
      `history_full finalize progress (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
    void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "history_full" });

    if (snapshotLatestId == null) {
      try {
        const latestList = await client.getMessages(sourceEntity, { limit: 1 });
        const latest = Array.isArray(latestList) ? latestList[0] : null;
        if (latest instanceof Api.Message && typeof latest.id === "number" && latest.id > 0) {
          snapshotLatestId = latest.id;
          console.log(`history_full snapshot latest source message id: ${snapshotLatestId}`);
          await logSyncEvent({
            sourceChannelId: source.id,
            level: "info",
            message: `history_full snapshot latestId=${snapshotLatestId} (taskId=${taskId})`,
          });
        }
      } catch (error: unknown) {
        if (!snapshotLatestIdFetchFailed) {
          const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
          console.warn(`failed to fetch history_full snapshot latest message id (retry): ${msg} (taskId=${taskId})`);
        }
      }
    }

    const remainingByProgress =
      typeof progressTotal === "number" && Number.isFinite(progressTotal) ? Math.max(0, progressTotal - progressCurrent) : null;
    const remainingById =
      typeof snapshotLatestId === "number" && Number.isFinite(snapshotLatestId) && snapshotLatestId > 0
        ? Math.max(0, snapshotLatestId - lastProcessedId)
        : null;

    const checkNextMessageAfter = async (
      afterId: number,
    ): Promise<{ kind: "none" } | { kind: "found"; id: number } | { kind: "error"; message: string }> => {
      const isTransient = (error: unknown): boolean => {
        const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
        if (!msg) return false;
        return (
          msg.includes("RPC_CALL_FAIL") ||
          msg.includes("TIMEOUT") ||
          msg.includes("ETIMEDOUT") ||
          msg.includes("ECONNRESET") ||
          msg.includes("EPIPE") ||
          msg.includes("CONNECTION_CLOSED") ||
          msg.includes("Connection closed") ||
          msg.includes("Network") ||
          msg.includes("network") ||
          msg.includes("socket") ||
          msg.includes("Socket")
        );
      };

      const delaysMs = [0, 250, 750];
      let lastError: unknown = null;

      for (const delayMs of delaysMs) {
        if (delayMs > 0) await sleep(delayMs);
        try {
          const list = await client.getMessages(sourceEntity, { limit: 1, minId: afterId });
          const next = Array.isArray(list) ? list[0] : null;
          if (next instanceof Api.Message && typeof next.id === "number" && next.id > afterId) return { kind: "found", id: next.id };
          return { kind: "none" };
        } catch (error: unknown) {
          lastError = error;
          const waitSeconds = parseFloodWaitSeconds(error);
          if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
            await sleep((waitSeconds + 1) * 1000);
            continue;
          }
          if (isTransient(error)) {
            continue;
          }
          const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
          return { kind: "error", message: msg };
        }
      }

      const msg = getTelegramErrorMessage(lastError) ?? (lastError instanceof Error ? lastError.message : String(lastError));
      return { kind: "error", message: msg };
    };

    const nextCheck = await checkNextMessageAfter(lastProcessedId);
    if (nextCheck.kind === "error") {
      const details = `history_full completion check failed; pausing (taskId=${taskId}) progress=${progressCurrent}/${progressTotal ?? "-"} lastId=${lastProcessedId}${snapshotLatestId ? ` snapshotLatestId=${snapshotLatestId}` : ""} err=${nextCheck.message}`;
      await pauseTask(taskId, details, { progressCurrent, progressTotal, lastProcessedId });
      return;
    }

    if (nextCheck.kind === "none") break;

    const progressedThisRound = progressCurrent > roundStartProgress || lastProcessedId > roundStartLastId;
    if (progressedThisRound) {
      noProgressRounds = 0;
    } else {
      noProgressRounds += 1;
    }
    const details = `history_full seems incomplete; auto continuing (taskId=${taskId}) progress=${progressCurrent}/${progressTotal ?? "-"} lastId=${lastProcessedId}${snapshotLatestId ? ` snapshotLatestId=${snapshotLatestId}` : ""}${remainingById != null ? ` remainingById=${remainingById}` : ""}${remainingByProgress != null ? ` remainingByProgress=${remainingByProgress}` : ""} nextId=${nextCheck.id}`;

    if (!progressedThisRound && noProgressRounds >= 2) {
      await pauseTask(taskId, `${details} (no progress in last round)`, { progressCurrent, progressTotal, lastProcessedId });
      return;
    }

    console.warn(details);

    if (roundStartedAt - lastUnexpectedEndAt > 60_000) {
      lastUnexpectedEndAt = roundStartedAt;
      await logSyncEvent({ sourceChannelId: source.id, level: "warn", message: details });
    }

    if (!(await ensureActiveOrPause())) return;
    await sleep(1000);
  }

  await withDbRetry(
    () =>
      db
        .update(schema.syncTasks)
        .set({ status: "completed", completedAt: new Date(), lastError: null })
        .where(eq(schema.syncTasks.id, taskId)),
    `history_full mark completed (taskId=${taskId})`,
    { attempts: 3, baseDelayMs: 250 },
  );
  void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "history_full", status: "completed" });

  await withDbRetry(
    () =>
      db
        .update(schema.sourceChannels)
        .set({ syncStatus: "completed" })
        .where(eq(schema.sourceChannels.id, source.id)),
    `history_full mark source completed (taskId=${taskId})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  console.log(`history_full task done: ${taskId}`);
  await logSyncEvent({
    sourceChannelId: source.id,
    level: "info",
    message: `history_full completed (taskId=${taskId}) progress=${progressCurrent}/${progressTotal ?? "-"} lastId=${lastProcessedId}`,
  });
}
