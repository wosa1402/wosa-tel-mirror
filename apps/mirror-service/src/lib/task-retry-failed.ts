import { and, asc, eq, gt, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { Api, TelegramClient } from "telegram";
import { sleep } from "../utils/sleep";
import { updateMessageMappingsByIds } from "./message-mappings";
import { classifyMirrorError } from "./mirror-message";
import { logSyncEvent } from "./sync-events";
import { pauseTask } from "./task-lifecycle";
import { notifyTasksChanged } from "./tasks-notify";
import { getTelegramErrorMessage, parseFloodWaitSeconds } from "./telegram-errors";
import { forwardMessagesAsCopy } from "./telegram-forward";
import { buildSourceMessageLink } from "./telegram-identifiers";
import { getLinkedDiscussionChatFilter } from "./telegram-metadata";
import { ensureDiscussionGroupForAutoMirrorChannel } from "./telegram-auto-channel";
import { ensureOriginalLinkComment as ensureOriginalLinkCommentImpl } from "./telegram-original-link";
import { resolvePeer } from "./telegram-peer";
import {
  getEffectiveMessageFilterSettings,
  getMirrorBehaviorSettings,
  getRetryBehaviorSettings,
  shouldSkipMessageByFilter,
  throttleMirrorSend,
} from "./settings";
import { syncCommentsForPost as syncCommentsForPostImpl } from "./telegram-comments";

export type RetryFailedTaskOptions = {
  floodWaitAutoSleepMaxSec: number;
};

export async function processRetryFailedTask(client: TelegramClient, taskId: string, sourceChannelId: string, options: RetryFailedTaskOptions): Promise<void> {
  const FLOOD_WAIT_AUTO_SLEEP_MAX_SEC = options.floodWaitAutoSleepMaxSec;
  type GetMessagesPeer = Parameters<TelegramClient["getMessages"]>[0];
  type SendMessagePeer = Parameters<TelegramClient["sendMessage"]>[0];

  const ensureOriginalLinkComment = (
    client: TelegramClient,
    args: { mirrorEntity: unknown; mirrorChannelId: string; mirrorPostId: number; sourceLink: string | null },
  ) => ensureOriginalLinkCommentImpl(client, args, { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC });

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
  ) => syncCommentsForPostImpl(client, args, { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC });

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
  console.log(`retry_failed task start: ${taskId} source=${source.channelIdentifier} mode=${mode}`);
  await logSyncEvent({ sourceChannelId: source.id, level: "info", message: `retry_failed started mode=${mode} (taskId=${taskId})` });

  const sourceEntity = (await resolvePeer(client, source.channelIdentifier)).entity;
  const mirrorEntity = (await resolvePeer(client, mirror.channelIdentifier)).entity;

  const mirrorBehavior = await getMirrorBehaviorSettings();
  const retryBehavior = await getRetryBehaviorSettings();

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

  if (!task.startedAt) {
    await db.update(schema.syncTasks).set({ startedAt: new Date() }).where(eq(schema.syncTasks.id, taskId));
    void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "retry_failed", status: "running" });
  }

  if (retryBehavior.maxRetryCount <= 0) {
    await db
      .update(schema.syncTasks)
      .set({ status: "completed", completedAt: new Date(), lastError: null, progressTotal: 0, lastProcessedId: null })
      .where(eq(schema.syncTasks.id, taskId));
    void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "retry_failed", status: "completed" });
    await logSyncEvent({
      sourceChannelId: source.id,
      level: "info",
      message: `retry_failed disabled (max_retry_count=0) (taskId=${taskId})`,
    });
    return;
  }

  if (retryBehavior.skipAfterMaxRetry && retryBehavior.maxRetryCount > 0) {
    try {
      await db
        .update(schema.messageMappings)
        .set({ status: "skipped", skipReason: "failed_too_many_times", mirroredAt: new Date() })
        .where(
          and(
            eq(schema.messageMappings.sourceChannelId, source.id),
            eq(schema.messageMappings.status, "failed"),
            gte(schema.messageMappings.retryCount, retryBehavior.maxRetryCount),
          ),
        );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`retry_failed failed to skip mappings after max retry (taskId=${taskId}): ${msg}`);
    }
  }

  let progressTotal: number | null = task.progressTotal ?? null;
  if (progressTotal == null) {
    try {
      const [row] = await db
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(schema.messageMappings)
        .where(
          and(
            eq(schema.messageMappings.sourceChannelId, source.id),
            eq(schema.messageMappings.status, "failed"),
            lt(schema.messageMappings.retryCount, retryBehavior.maxRetryCount),
            or(isNull(schema.messageMappings.skipReason), ne(schema.messageMappings.skipReason, "protected_content")),
          ),
        )
        .limit(1);
      progressTotal = row?.count ?? 0;
      await db.update(schema.syncTasks).set({ progressTotal }).where(eq(schema.syncTasks.id, taskId));
      void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "retry_failed" });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`retry_failed failed to compute progress_total (taskId=${taskId}): ${msg}`);
    }
  }

  let progressCurrent = task.progressCurrent ?? 0;
  let lastProcessedId = task.lastProcessedId ?? 0;

  let lastPersistAt = Date.now();
  let lastPersistedProgress = progressCurrent;
  let lastPersistedProcessedId = lastProcessedId;

  const persistProgress = async () => {
    const now = Date.now();
    if (now - lastPersistAt < 2_000 && progressCurrent - lastPersistedProgress < 50) return;
    await db.update(schema.syncTasks).set({ progressCurrent, lastProcessedId }).where(eq(schema.syncTasks.id, taskId));
    void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "retry_failed" });
    lastPersistAt = now;
    lastPersistedProgress = progressCurrent;
    lastPersistedProcessedId = lastProcessedId;
  };

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
      await pauseTask(taskId, "source channel is disabled");
    }

    return lastActiveValue;
  };

  type PendingRetryItem = {
    mappingId: string;
    sourceMessageId: number;
    retryCount: number;
    text: string | null;
  };

  let pending: PendingRetryItem[] = [];
  let pendingGroupId: string | null = null;

  const advanceProgressFor = async (messageId: number) => {
    lastProcessedId = messageId;
    progressCurrent += 1;
    await persistProgress();
  };

  const flushPending = async (): Promise<"ok" | "paused"> => {
    if (!pending.length) return "ok";
    if (!(await ensureActiveOrPause())) return "paused";

    const items = [...pending].sort((a, b) => a.sourceMessageId - b.sourceMessageId);
    pending = [];
    pendingGroupId = null;

    const messageIds = items.map((i) => i.sourceMessageId);
    const mappingIds = items.map((i) => i.mappingId);

    const messageFilter = await getEffectiveMessageFilterSettings(source.id);
    const shouldFilter =
      messageFilter.enabled &&
      messageFilter.keywords.length > 0 &&
      items.some((item) => shouldSkipMessageByFilter(item.text ?? "", messageFilter));

    if (shouldFilter) {
      await updateMessageMappingsByIds(
        mappingIds,
        { status: "skipped", skipReason: "filtered", mirroredAt: new Date(), errorMessage: null },
        "retry_failed skip:filtered",
      );

      for (const item of items) {
        await advanceProgressFor(item.sourceMessageId);
      }
      return "ok";
    }

    const sourceMessages = new Map<number, Api.Message>();

    if (mode === "copy" || canSyncComments) {
      try {
        const list = await client.getMessages(sourceEntity as GetMessagesPeer, { ids: messageIds });
        for (const msg of list ?? []) {
          if (msg instanceof Api.Message && msg.id) sourceMessages.set(msg.id, msg);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`retry_failed: failed to fetch source messages: ${msg}`);
      }
    }

    const syncCommentsIfNeeded = async (sourceMsg: Api.Message | undefined, mirrorPostId: number | undefined) => {
      if (!canSyncComments || !mirrorPostId || !sourceMsg?.post) return;
      const replies = sourceMsg.replies;
      if (!(replies instanceof Api.MessageReplies) || replies.replies <= 0) return;
      await syncCommentsForPost(client, {
        sourceEntity,
        mirrorEntity,
        mirrorChannelId: mirror.id,
        sourceChannel: source,
        sourcePostId: sourceMsg.id,
        mirrorPostId,
        maxComments: maxCommentsPerPost,
      });
    };

    const markRetryFailure = async (item: PendingRetryItem, errorMessage: string): Promise<void> => {
      const nextRetryCount = item.retryCount + 1;
      const base = { retryCount: nextRetryCount, errorMessage, mirroredAt: new Date() } as const;

      if (retryBehavior.skipAfterMaxRetry && nextRetryCount >= retryBehavior.maxRetryCount) {
        await db
          .update(schema.messageMappings)
          .set({ status: "skipped", skipReason: "failed_too_many_times", ...base })
          .where(eq(schema.messageMappings.id, item.mappingId));
        return;
      }

      await db
        .update(schema.messageMappings)
        .set({ status: "failed", skipReason: null, ...base })
        .where(eq(schema.messageMappings.id, item.mappingId));
    };

    if (mode === "forward") {
      const tryForwardOnce = async () =>
        await forwardMessagesAsCopy(client, { fromPeer: sourceEntity, toPeer: mirrorEntity, messageIds });

      try {
        const forwarded = await tryForwardOnce();
        await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);

        for (let i = 0; i < items.length; i += 1) {
          const mirrorMessageId = forwarded[i]?.id ?? null;
          if (mirrorMessageId == null) {
            await markRetryFailure(items[i]!, "missing forwarded message mapping");
          } else {
            await db
              .update(schema.messageMappings)
              .set({ status: "success", mirrorMessageId, mirroredAt: new Date(), errorMessage: null })
              .where(eq(schema.messageMappings.id, items[i]!.mappingId));
          }
        }

        if (canPostOriginalLinkComment) {
          const anchorSourceMessageId = items[0]?.sourceMessageId;
          const mirrorPostId = forwarded[0]?.id;
          const anchorSourceMsg = anchorSourceMessageId ? sourceMessages.get(anchorSourceMessageId) : undefined;
          if (mirrorPostId && (anchorSourceMsg ? anchorSourceMsg.post : true) && anchorSourceMessageId) {
            const link = buildSourceMessageLink(source, anchorSourceMessageId);
            await ensureOriginalLinkComment(client, { mirrorEntity, mirrorChannelId: mirror.id, mirrorPostId, sourceLink: link });
          }
        }

        if (canSyncComments) {
          for (let i = 0; i < items.length; i += 1) {
            const sourceMsg = sourceMessages.get(items[i]!.sourceMessageId);
            await syncCommentsIfNeeded(sourceMsg, forwarded[i]?.id);
          }
        }
      } catch (error: unknown) {
        const { skipReason } = classifyMirrorError(error);
        if (skipReason) {
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
              "retry_failed protected_content blocked",
            );
            await pauseTask(taskId, msg0);
            return "paused";
          }

          await updateMessageMappingsByIds(
            mappingIds,
            { status: "skipped", skipReason, mirroredAt: new Date(), errorMessage: null },
            `retry_failed skip:${skipReason}`,
          );

          for (const item of items) {
            await advanceProgressFor(item.sourceMessageId);
          }
          return "ok";
        }

        const waitSeconds = parseFloodWaitSeconds(error);
        if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
          await sleep(waitSeconds * 1000);
          try {
            const forwarded = await tryForwardOnce();
            await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);

            for (let i = 0; i < items.length; i += 1) {
              const mirrorMessageId = forwarded[i]?.id ?? null;
              if (mirrorMessageId == null) {
                await markRetryFailure(items[i]!, "missing forwarded message mapping");
              } else {
                await db
                  .update(schema.messageMappings)
                  .set({ status: "success", mirrorMessageId, mirroredAt: new Date(), errorMessage: null })
                  .where(eq(schema.messageMappings.id, items[i]!.mappingId));
              }
            }

            if (canPostOriginalLinkComment) {
              const anchorSourceMessageId = items[0]?.sourceMessageId;
              const mirrorPostId = forwarded[0]?.id;
              const anchorSourceMsg = anchorSourceMessageId ? sourceMessages.get(anchorSourceMessageId) : undefined;
              if (mirrorPostId && (anchorSourceMsg ? anchorSourceMsg.post : true) && anchorSourceMessageId) {
                const link = buildSourceMessageLink(source, anchorSourceMessageId);
                await ensureOriginalLinkComment(client, { mirrorEntity, mirrorChannelId: mirror.id, mirrorPostId, sourceLink: link });
              }
            }

            if (canSyncComments) {
              for (let i = 0; i < items.length; i += 1) {
                const sourceMsg = sourceMessages.get(items[i]!.sourceMessageId);
                await syncCommentsIfNeeded(sourceMsg, forwarded[i]?.id);
              }
            }
          } catch (error2: unknown) {
            const { skipReason: skipReason2 } = classifyMirrorError(error2);
            if (skipReason2) {
              if (skipReason2 === "protected_content" && !source.isProtected) {
                try {
                  await db.update(schema.sourceChannels).set({ isProtected: true }).where(eq(schema.sourceChannels.id, source.id));
                  source.isProtected = true;
                } catch (e: unknown) {
                  const msg = e instanceof Error ? e.message : String(e);
                  console.warn(`failed to mark source channel protected: ${source.id} - ${msg}`);
                }
              }

              if (skipReason2 === "protected_content" && !mirrorBehavior.skipProtectedContent) {
                const msg2 = getTelegramErrorMessage(error2) ?? (error2 instanceof Error ? error2.message : String(error2));
                await updateMessageMappingsByIds(
                  mappingIds,
                  { status: "failed", skipReason: "protected_content", errorMessage: msg2, mirroredAt: new Date() },
                  "retry_failed protected_content blocked",
                );
                await pauseTask(taskId, msg2);
                return "paused";
              }

              await updateMessageMappingsByIds(
                mappingIds,
                { status: "skipped", skipReason: skipReason2, mirroredAt: new Date(), errorMessage: null },
                `retry_failed skip:${skipReason2}`,
              );
            } else {
              const msg2 = error2 instanceof Error ? error2.message : getTelegramErrorMessage(error2) ?? String(error2);
              for (const item of items) {
                await markRetryFailure(item, msg2);
              }
            }
          }
        } else if (waitSeconds && waitSeconds > FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
          const msg1 = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
          await pauseTask(taskId, msg1);
          return "paused";
        } else {
          const msg1 = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
          for (const item of items) {
            await markRetryFailure(item, msg1);
          }
        }
      }
    } else {
      for (const item of items) {
        const sourceMsg = sourceMessages.get(item.sourceMessageId);
        if (!sourceMsg) {
          await db
            .update(schema.messageMappings)
            .set({ status: "skipped", skipReason: "message_deleted", mirroredAt: new Date(), errorMessage: null })
            .where(eq(schema.messageMappings.id, item.mappingId));
          await advanceProgressFor(item.sourceMessageId);
          continue;
        }

        const text = typeof sourceMsg.message === "string" ? sourceMsg.message : "";
        const content = text.trim();

        if (!content) {
          await db
            .update(schema.messageMappings)
            .set({ status: "skipped", skipReason: "unsupported_type", mirroredAt: new Date(), errorMessage: null })
            .where(eq(schema.messageMappings.id, item.mappingId));
          await advanceProgressFor(item.sourceMessageId);
          continue;
        }

        try {
          const sent = await client.sendMessage(mirrorEntity as SendMessagePeer, { message: content });
          await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);
          await db
            .update(schema.messageMappings)
            .set({ status: "success", mirrorMessageId: sent?.id ?? null, mirroredAt: new Date(), errorMessage: null })
            .where(eq(schema.messageMappings.id, item.mappingId));

          if (canPostOriginalLinkComment && sent?.id && sourceMsg.post) {
            const link = buildSourceMessageLink(source, sourceMsg.id);
            await ensureOriginalLinkComment(client, {
              mirrorEntity,
              mirrorChannelId: mirror.id,
              mirrorPostId: sent.id,
              sourceLink: link,
            });
          }

          await syncCommentsIfNeeded(sourceMsg, sent?.id);
        } catch (error: unknown) {
          const { skipReason } = classifyMirrorError(error);
          if (skipReason) {
            await db
              .update(schema.messageMappings)
              .set({ status: "skipped", skipReason, mirroredAt: new Date(), errorMessage: null })
              .where(eq(schema.messageMappings.id, item.mappingId));
          } else {
            const waitSeconds = parseFloodWaitSeconds(error);
            if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
              await sleep(waitSeconds * 1000);
              try {
                const sent = await client.sendMessage(mirrorEntity as SendMessagePeer, { message: content });
                await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);
                await db
                  .update(schema.messageMappings)
                  .set({ status: "success", mirrorMessageId: sent?.id ?? null, mirroredAt: new Date(), errorMessage: null })
                  .where(eq(schema.messageMappings.id, item.mappingId));

                if (canPostOriginalLinkComment && sent?.id && sourceMsg.post) {
                  const link = buildSourceMessageLink(source, sourceMsg.id);
                  await ensureOriginalLinkComment(client, {
                    mirrorEntity,
                    mirrorChannelId: mirror.id,
                    mirrorPostId: sent.id,
                    sourceLink: link,
                  });
                }
                await syncCommentsIfNeeded(sourceMsg, sent?.id);
              } catch (error2: unknown) {
                const msg2 = error2 instanceof Error ? error2.message : getTelegramErrorMessage(error2) ?? String(error2);
                await markRetryFailure(item, msg2);
              }
            } else if (waitSeconds && waitSeconds > FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
              const msg1 = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
              await pauseTask(taskId, msg1);
              return "paused";
            } else {
              const msg1 = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
              await markRetryFailure(item, msg1);
            }
          }
        }

        await advanceProgressFor(item.sourceMessageId);
      }

      return "ok";
    }

    for (const item of items) {
      await advanceProgressFor(item.sourceMessageId);
    }

    return "ok";
  };

  for (;;) {
    if (!(await ensureActiveOrPause())) return;

    const rows = await db
      .select({
        id: schema.messageMappings.id,
        sourceMessageId: schema.messageMappings.sourceMessageId,
        mediaGroupId: schema.messageMappings.mediaGroupId,
        retryCount: schema.messageMappings.retryCount,
        text: schema.messageMappings.text,
      })
      .from(schema.messageMappings)
      .where(
        and(
          eq(schema.messageMappings.sourceChannelId, source.id),
          eq(schema.messageMappings.status, "failed"),
          lt(schema.messageMappings.retryCount, retryBehavior.maxRetryCount),
          or(isNull(schema.messageMappings.skipReason), ne(schema.messageMappings.skipReason, "protected_content")),
          gt(schema.messageMappings.sourceMessageId, lastProcessedId),
        ),
      )
      .orderBy(asc(schema.messageMappings.sourceMessageId))
      .limit(200);

    if (!rows.length) break;

    for (const row of rows) {
      if (!(await ensureActiveOrPause())) return;

      const groupId = mode === "forward" ? row.mediaGroupId : null;
      if (pending.length && pendingGroupId !== groupId) {
        const result = await flushPending();
        if (result === "paused") return;
      }

      pendingGroupId = groupId;
      pending.push({ mappingId: row.id, sourceMessageId: row.sourceMessageId, retryCount: row.retryCount, text: row.text ?? null });

      if (!groupId) {
        const result = await flushPending();
        if (result === "paused") return;
      }
    }

    const result = await flushPending();
    if (result === "paused") return;
  }

  const finalResult = await flushPending();
  if (finalResult === "paused") return;

  await db.update(schema.syncTasks).set({ progressCurrent, lastProcessedId }).where(eq(schema.syncTasks.id, taskId));
  void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "retry_failed" });

  await db
    .update(schema.syncTasks)
    .set({ status: "completed", completedAt: new Date(), lastError: null })
    .where(eq(schema.syncTasks.id, taskId));
  void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "retry_failed", status: "completed" });

  console.log(`retry_failed task done: ${taskId}`);
  await logSyncEvent({
    sourceChannelId: source.id,
    level: "info",
    message: `retry_failed completed (taskId=${taskId}) progress=${progressCurrent}/${progressTotal ?? "-"} lastId=${lastProcessedId}`,
  });
}
