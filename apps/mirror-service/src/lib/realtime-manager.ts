import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { Api, TelegramClient } from "telegram";
import type { EntityLike, FileLike } from "telegram/define";
import { NewMessage, Raw } from "telegram/events";
import { sleep } from "../utils/sleep";
import { toBigIntOrNull } from "./bigint";
import { withDbRetry } from "./db-retry";
import { updateMessageMappingsByIds } from "./message-mappings";
import { classifyMirrorError, extractMediaFileSize, messageTypeFromMessage } from "./mirror-message";
import { omitUndefined } from "./omit-undefined";
import { logSyncEvent } from "./sync-events";
import { markTaskFailed, pauseTask } from "./task-lifecycle";
import { notifyTasksChanged } from "./tasks-notify";
import { getTelegramErrorMessage, isRetryableCommentThreadError, parseFloodWaitSeconds } from "./telegram-errors";
import { syncCommentsForPost as syncCommentsForPostImpl } from "./telegram-comments";
import { forwardMessagesAsCopy } from "./telegram-forward";
import { ensureMirrorMessageSpoiler as ensureMirrorMessageSpoilerImpl, getSendFileMediaForMessage } from "./telegram-spoiler";
import { ensureOriginalLinkComment as ensureOriginalLinkCommentImpl } from "./telegram-original-link";
import { ensureAutoChannelAdmins, ensureDiscussionGroupForAutoMirrorChannel } from "./telegram-auto-channel";
import { buildSourceMessageLink, normalizeChatIdentifier, parseTelegramInviteHash } from "./telegram-identifiers";
import { getLinkedDiscussionChatFilter } from "./telegram-metadata";
import { resolvePeer } from "./telegram-peer";
import { readArrayProp, readBooleanProp, readNumberProp, readProp, readStringProp } from "./object-props";
import {
  getAutoChannelSettings,
  getEffectiveMessageFilterSettings,
  getMirrorBehaviorSettings,
  getRetryBehaviorSettings,
  getRuntimeSettings,
  shouldSkipMessageByFilter,
  throttleMirrorSend,
} from "./settings";

export type RealtimeManagerOptions = {
  floodWaitAutoSleepMaxSec: number;
};

export function createRealtimeManager(client: TelegramClient, options: RealtimeManagerOptions) {
  const FLOOD_WAIT_AUTO_SLEEP_MAX_SEC = options.floodWaitAutoSleepMaxSec;
  const warnedAt = new Map<string, number>();

  const warnOnce = (key: string, message: string, intervalMs = 60_000): void => {
    const now = Date.now();
    const lastAt = warnedAt.get(key) ?? 0;
    if (lastAt && now - lastAt < intervalMs) return;
    warnedAt.set(key, now);
    console.warn(message);
  };

  async function ensureMirrorMessageSpoiler(
    client: TelegramClient,
    {
      mirrorPeer,
      mirrorMessageId,
      sourceMessage,
      mirroredMessage,
    }: {
      mirrorPeer: unknown;
      mirrorMessageId: number;
      sourceMessage: Api.Message;
      mirroredMessage?: Api.Message | null;
    },
  ): Promise<void> {
    return ensureMirrorMessageSpoilerImpl(
      client,
      { mirrorPeer, mirrorMessageId, sourceMessage, mirroredMessage },
      { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC },
    );
  }

  async function ensureOriginalLinkComment(
    client: TelegramClient,
    {
      mirrorEntity,
      mirrorChannelId,
      mirrorPostId,
      sourceLink,
    }: {
      mirrorEntity: unknown;
      mirrorChannelId: string;
      mirrorPostId: number;
      sourceLink: string | null;
    },
  ): Promise<void> {
    return ensureOriginalLinkCommentImpl(
      client,
      { mirrorEntity, mirrorChannelId, mirrorPostId, sourceLink },
      { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC },
    );
  }

  async function syncCommentsForPost(
    client: TelegramClient,
    {
      sourceEntity,
      mirrorEntity,
      mirrorChannelId,
      sourceChannel,
      sourcePostId,
      mirrorPostId,
      maxComments,
    }: {
      sourceEntity: unknown;
      mirrorEntity: unknown;
      mirrorChannelId: string;
      sourceChannel: { username?: string | null; telegramId?: bigint | null };
      sourcePostId: number;
      mirrorPostId: number;
      maxComments: number;
    },
  ): Promise<void> {
    return syncCommentsForPostImpl(
      client,
      { sourceEntity, mirrorEntity, mirrorChannelId, sourceChannel, sourcePostId, mirrorPostId, maxComments },
      { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC },
    );
  }
type RealtimeSubscription = {
  sourceChannelId: string;
  mirrorChannelId: string;
};

class RealtimeManager {
  private subscriptions = new Map<string, RealtimeSubscription>();
  private subscribedTelegramIds = new Map<string, string>();
  private rawHandlersAttached = false;

  constructor(private client: TelegramClient) {
    this.attachRawHandlers();
  }

  private attachRawHandlers(): void {
    if (this.rawHandlersAttached) return;
    this.rawHandlersAttached = true;

    const resolveSourceChannelIdByTelegramKey = async (channelKey: string): Promise<string | null> => {
      const cached = this.subscribedTelegramIds.get(channelKey);
      if (cached) return cached;

      const telegramId = toBigIntOrNull(channelKey);
      if (telegramId == null || telegramId <= 0n) return null;

      const [row] = await db
        .select({ id: schema.sourceChannels.id })
        .from(schema.sourceChannels)
        .where(eq(schema.sourceChannels.telegramId, telegramId))
        .limit(1);
      if (!row) return null;

      this.subscribedTelegramIds.set(channelKey, row.id);
      return row.id;
    };

    this.client.addEventHandler(
      async (update) => {
        try {
          const settings = await getRuntimeSettings();
          if (!settings.syncMessageEdits) return;
          if (!(update instanceof Api.UpdateEditChannelMessage)) return;

          const message = update.message;
          if (!(message instanceof Api.Message)) return;
          if (!message.id) return;

          const peer = message.peerId;
          if (!(peer instanceof Api.PeerChannel)) return;
          const channelKey = peer.channelId.toString();
          const sourceChannelId = await resolveSourceChannelIdByTelegramKey(channelKey);
          if (!sourceChannelId) return;

          const editedAt = message.editDate && message.editDate > 0 ? new Date(message.editDate * 1000) : new Date();

          const [existing] = await db
            .select({
              id: schema.messageMappings.id,
              mirroredAt: schema.messageMappings.mirroredAt,
              lastEditedAt: schema.messageMappings.lastEditedAt,
              editCount: schema.messageMappings.editCount,
              text: schema.messageMappings.text,
            })
            .from(schema.messageMappings)
            .where(and(eq(schema.messageMappings.sourceChannelId, sourceChannelId), eq(schema.messageMappings.sourceMessageId, message.id)))
            .limit(1);

          if (!existing) return;

          const rawText = typeof message.message === "string" ? message.message : "";
          const nextText = rawText.trim() ? rawText : null;
          const nextTextPreview = nextText ? (nextText.length > 200 ? nextText.slice(0, 200) : nextText) : null;

          const previousText = existing.text ?? null;
          const textChanged = previousText !== nextText;

          const lastEditedAtMs = existing.lastEditedAt ? existing.lastEditedAt.getTime() : null;
          const editedAtMs = editedAt.getTime();

          if (!textChanged) return;

          const isNewer = lastEditedAtMs == null || editedAtMs >= lastEditedAtMs;
          if (!isNewer) return;

          const updated = await db
            .update(schema.messageMappings)
            .set({
              text: nextText,
              textPreview: nextTextPreview,
              editCount: sql`${schema.messageMappings.editCount} + 1`,
              lastEditedAt: editedAt,
            })
            .where(eq(schema.messageMappings.id, existing.id))
            .returning({ editCount: schema.messageMappings.editCount });

          const newEditCount = updated[0]?.editCount ?? existing.editCount + 1;

          if (settings.keepEditHistory) {
            await db
              .insert(schema.messageEdits)
              .values({
                messageMappingId: existing.id,
                version: newEditCount,
                previousText,
                newText: nextText,
                editedAt,
              })
              .onConflictDoNothing();
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`failed to record message edit: ${msg}`);
        }
      },
      new Raw({ types: [Api.UpdateEditChannelMessage] }),
    );

    this.client.addEventHandler(
      async (update) => {
        try {
          const settings = await getRuntimeSettings();
          if (!settings.syncMessageDeletions) return;
          if (!(update instanceof Api.UpdateDeleteChannelMessages)) return;

          const channelKey = update.channelId.toString();
          const sourceChannelId = await resolveSourceChannelIdByTelegramKey(channelKey);
          if (!sourceChannelId) return;

          const messageIds = Array.isArray(update.messages)
            ? [...new Set(update.messages)].filter((id): id is number => typeof id === "number" && Number.isFinite(id) && id > 0)
            : [];
          if (!messageIds.length) return;

          const deletedAt = new Date();

          const batchSize = 500;
          for (let i = 0; i < messageIds.length; i += batchSize) {
            const batch = messageIds.slice(i, i + batchSize);
            await db
              .update(schema.messageMappings)
              .set({ isDeleted: true, deletedAt })
              .where(and(eq(schema.messageMappings.sourceChannelId, sourceChannelId), inArray(schema.messageMappings.sourceMessageId, batch)));
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`failed to record message deletion: ${msg}`);
        }
      },
      new Raw({ types: [Api.UpdateDeleteChannelMessages] }),
    );
  }

  has(sourceChannelId: string): boolean {
    return this.subscriptions.has(sourceChannelId);
  }

  async ensure(): Promise<void> {
    const tasks = await db
      .select({ id: schema.syncTasks.id, sourceChannelId: schema.syncTasks.sourceChannelId, status: schema.syncTasks.status })
      .from(schema.syncTasks)
      .where(and(eq(schema.syncTasks.taskType, "realtime"), inArray(schema.syncTasks.status, ["pending", "running"])));

    for (const task of tasks) {
      if (this.has(task.sourceChannelId)) continue;
      await this.trySubscribe(task.id, task.sourceChannelId);
    }
  }

  private async trySubscribe(taskId: string, sourceChannelId: string): Promise<void> {
    const [source] = await db.select().from(schema.sourceChannels).where(eq(schema.sourceChannels.id, sourceChannelId));
    if (!source || !source.isActive) return;

    const [historyBlocker] = await db
      .select({ id: schema.syncTasks.id })
      .from(schema.syncTasks)
      .where(
        and(
          eq(schema.syncTasks.sourceChannelId, source.id),
          eq(schema.syncTasks.taskType, "history_full"),
          inArray(schema.syncTasks.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    if (historyBlocker) return;

    const [mirror] = await db
      .select()
      .from(schema.mirrorChannels)
      .where(eq(schema.mirrorChannels.sourceChannelId, source.id))
      .limit(1);
    if (!mirror) return;

    if (!source.telegramId) return;
    this.subscribedTelegramIds.set(source.telegramId.toString(), source.id);

    if (!mirror.telegramId) {
      try {
        const resolvedMirror = await resolvePeer(this.client, mirror.channelIdentifier);
        await db
          .update(schema.mirrorChannels)
          .set({
            telegramId: resolvedMirror.telegramId,
            accessHash: resolvedMirror.accessHash,
            name: resolvedMirror.name,
            username: resolvedMirror.username,
          })
          .where(eq(schema.mirrorChannels.id, mirror.id));
        mirror.telegramId = resolvedMirror.telegramId;
        mirror.accessHash = resolvedMirror.accessHash;
        mirror.name = resolvedMirror.name;
        mirror.username = resolvedMirror.username;
      } catch (error: unknown) {
        await markTaskFailed(taskId, error);
        return;
      }
    }

    const sourceEntity = (await resolvePeer(this.client, source.channelIdentifier)).entity;
    const mirrorEntity = (await resolvePeer(this.client, mirror.channelIdentifier)).entity;
    const mode = source.mirrorMode ?? "forward";

    const mirrorBehavior = await getMirrorBehaviorSettings();

    const syncCommentsEnabled = process.env.MIRROR_SYNC_COMMENTS?.trim() !== "false";
    const maxCommentsPerPostRaw = Number.parseInt(process.env.MIRROR_MAX_COMMENTS_PER_POST ?? "500", 10);
    const maxCommentsPerPost =
      Number.isFinite(maxCommentsPerPostRaw) && maxCommentsPerPostRaw > 0 ? Math.min(maxCommentsPerPostRaw, 10_000) : 500;

    const sourceDiscussionChatFilter = syncCommentsEnabled ? await getLinkedDiscussionChatFilter(this.client, sourceEntity) : null;
    let mirrorDiscussionChatFilter = syncCommentsEnabled ? await getLinkedDiscussionChatFilter(this.client, mirrorEntity) : null;

    if (syncCommentsEnabled && !mirrorDiscussionChatFilter && mirror.isAutoCreated && mirrorEntity instanceof Api.Channel) {
      try {
        mirrorDiscussionChatFilter = await ensureDiscussionGroupForAutoMirrorChannel(
          this.client,
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

    let discussionEntity: unknown = null;
    const canSyncComments = syncCommentsEnabled && !!sourceDiscussionChatFilter && !!mirrorDiscussionChatFilter;
    if (canSyncComments) {
      try {
        discussionEntity = await this.client.getEntity(sourceDiscussionChatFilter!);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        console.warn(`comments sync disabled (failed to resolve discussion chat): ${msg}`);
        discussionEntity = null;
      }
    }

    const sourceChatFilter = normalizeChatIdentifier(source.channelIdentifier);
    const eventBuilder = new NewMessage({ chats: [sourceChatFilter] });
    try {
      await eventBuilder.resolve(this.client);
    } catch (error: unknown) {
      await markTaskFailed(taskId, error);
      return;
    }

    const mediaGroupBuffers = new Map<
      string,
      {
        items: Array<{ message: Api.Message; mappingId: string }>;
        timeout: NodeJS.Timeout | null;
      }
    >();

    const mirroredDiscussionMessageIds = new Set<number>();
    const discussionMediaGroupBuffers = new Map<
      string,
      {
        items: Api.Message[];
        mirrorPostId: number;
        sourcePostId: number;
        timeout: NodeJS.Timeout | null;
      }
    >();
    let reportedProtectedContent = false;

    let lastActiveCheckAt = 0;
    let cachedIsActive = true;
    let pausedLogged = false;

    const ensureActive = async (): Promise<boolean> => {
      const now = Date.now();
      if (now - lastActiveCheckAt < 5_000) return cachedIsActive;
      lastActiveCheckAt = now;

      const prevIsActive = cachedIsActive;
      let channelActive = true;
      let taskActive = true;
      try {
        const [row] = await db
          .select({ isActive: schema.sourceChannels.isActive })
          .from(schema.sourceChannels)
          .where(eq(schema.sourceChannels.id, source.id))
          .limit(1);
        channelActive = !!row?.isActive;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`failed to check channel active: ${msg}`);
        channelActive = true;
      }

      try {
        const [taskRow] = await db
          .select({ status: schema.syncTasks.status, lastError: schema.syncTasks.lastError })
        .from(schema.syncTasks)
        .where(eq(schema.syncTasks.id, taskId))
        .limit(1);
        const status = taskRow?.status ?? null;
        const pausedByUser = status === "paused" && (taskRow?.lastError ?? "") === "paused by user";
        taskActive = status === "pending" || status === "running" || pausedByUser;

          if (channelActive && (status === "pending" || pausedByUser)) {
            try {
              await db
                .update(schema.syncTasks)
                .set({ status: "running", startedAt: new Date(), pausedAt: null, lastError: null })
                .where(eq(schema.syncTasks.id, taskId));
              void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "realtime", status: "running" });
            } catch (error: unknown) {
              const msg = error instanceof Error ? error.message : String(error);
              warnOnce("realtime:mark-running", `realtime failed to mark task running (taskId=${taskId}): ${msg}`);
            }
          }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`failed to check realtime task status: ${msg}`);
        taskActive = true;
      }

      cachedIsActive = channelActive && taskActive;

      if (!cachedIsActive) {
        if (!channelActive) {
          if (prevIsActive || !pausedLogged) {
            pausedLogged = true;
            try {
              await pauseTask(taskId, "paused by user");
            } catch (error: unknown) {
              const msg = error instanceof Error ? error.message : String(error);
              warnOnce("realtime:pause-task", `realtime failed to pause task (taskId=${taskId}): ${msg}`);
            }
          }
        } else {
          pausedLogged = false;
        }
      } else {
        pausedLogged = false;
      }

      return cachedIsActive;
    };

    const flushMediaGroup = async (groupId: string): Promise<void> => {
      if (!(await ensureActive())) return;
      const entry = mediaGroupBuffers.get(groupId);
      if (!entry) return;
      mediaGroupBuffers.delete(groupId);
      if (entry.timeout) clearTimeout(entry.timeout);

      const items = [...entry.items].sort((a, b) => a.message.id - b.message.id);
      const mappingIds = items.map((i) => i.mappingId);
      const messageIds = items.map((i) => i.message.id);

      const messageFilter = await getEffectiveMessageFilterSettings(source.id);
      const shouldFilter =
        messageFilter.enabled &&
        messageFilter.keywords.length > 0 &&
        items.some((item) =>
          shouldSkipMessageByFilter(typeof item.message.message === "string" ? item.message.message : "", messageFilter),
        );

      if (shouldFilter) {
        await updateMessageMappingsByIds(
          mappingIds,
          { status: "skipped", skipReason: "filtered", mirroredAt: new Date(), errorMessage: null },
          "realtime album skip:filtered",
        );
        return;
      }

	      try {
	        const forwarded = await forwardMessagesAsCopy(this.client, {
	          fromPeer: sourceEntity,
	          toPeer: mirrorEntity,
	          messageIds,
	        });
	        await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);

	        for (let i = 0; i < items.length; i += 1) {
	          const mirrorMessageId = forwarded[i]?.id ?? null;
	          if (mirrorMessageId == null) {
            await db
              .update(schema.messageMappings)
              .set({ status: "failed", errorMessage: "missing forwarded message mapping", mirroredAt: new Date() })
              .where(eq(schema.messageMappings.id, items[i]!.mappingId));
	          } else {
	            await db
	              .update(schema.messageMappings)
	              .set({ status: "success", mirrorMessageId, mirroredAt: new Date(), errorMessage: null })
	              .where(eq(schema.messageMappings.id, items[i]!.mappingId));
	          }
	        }

	        for (let i = 0; i < items.length; i += 1) {
	          const mirrorMessageId = forwarded[i]?.id ?? null;
	          if (!mirrorMessageId) continue;
	          await ensureMirrorMessageSpoiler(this.client, {
	            mirrorPeer: mirrorEntity,
	            mirrorMessageId,
	            sourceMessage: items[i]!.message,
	            mirroredMessage: forwarded[i] ?? null,
	          });
	        }
	
	        await db
	          .update(schema.sourceChannels)
	          .set({ lastSyncAt: new Date(), lastMessageId: messageIds[messageIds.length - 1] })
          .where(eq(schema.sourceChannels.id, source.id));

        if (canPostOriginalLinkComment) {
          const anchor = items[0]?.message;
          const mirrorPostId = forwarded[0]?.id;
          if (anchor?.post && mirrorPostId) {
            const link = buildSourceMessageLink(source, anchor.id);
            void ensureOriginalLinkComment(this.client, {
              mirrorEntity,
              mirrorChannelId: mirror.id,
              mirrorPostId,
              sourceLink: link,
            });
          }
        }
      } catch (error: unknown) {
        const { skipReason } = classifyMirrorError(error);
        if (skipReason) {
          if (skipReason === "protected_content" && !reportedProtectedContent) {
            reportedProtectedContent = true;
            console.warn(
              `source channel has protected content enabled; realtime forwarding is blocked. New messages will be marked skipped (or realtime task paused if skip_protected_content=false).`,
            );
            await logSyncEvent({
              sourceChannelId: source.id,
              level: "warn",
              message: `protected content enabled; realtime forwarding blocked (taskId=${taskId})`,
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
              "realtime album protected_content blocked",
            );
            await pauseTask(taskId, msg0);
            return;
          }

          await updateMessageMappingsByIds(
            mappingIds,
            { status: "skipped", skipReason, mirroredAt: new Date(), errorMessage: null },
            `realtime album skip:${skipReason}`,
          );
          return;
        }

        const waitSeconds = parseFloodWaitSeconds(error);
        if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
          await sleep(waitSeconds * 1000);
	          try {
	            const forwarded = await forwardMessagesAsCopy(this.client, {
	              fromPeer: sourceEntity,
	              toPeer: mirrorEntity,
	              messageIds,
	            });
	            await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);

	            for (let i = 0; i < items.length; i += 1) {
	              const mirrorMessageId = forwarded[i]?.id ?? null;
	              if (mirrorMessageId == null) {
                await db
                  .update(schema.messageMappings)
                  .set({ status: "failed", errorMessage: "missing forwarded message mapping", mirroredAt: new Date() })
                  .where(eq(schema.messageMappings.id, items[i]!.mappingId));
	              } else {
	                await db
	                  .update(schema.messageMappings)
	                  .set({ status: "success", mirrorMessageId, mirroredAt: new Date(), errorMessage: null })
	                  .where(eq(schema.messageMappings.id, items[i]!.mappingId));
	              }
	            }

	            for (let i = 0; i < items.length; i += 1) {
	              const mirrorMessageId = forwarded[i]?.id ?? null;
	              if (!mirrorMessageId) continue;
	              await ensureMirrorMessageSpoiler(this.client, {
	                mirrorPeer: mirrorEntity,
	                mirrorMessageId,
	                sourceMessage: items[i]!.message,
	                mirroredMessage: forwarded[i] ?? null,
	              });
	            }
	
	            await db
	              .update(schema.sourceChannels)
	              .set({ lastSyncAt: new Date(), lastMessageId: messageIds[messageIds.length - 1] })
	              .where(eq(schema.sourceChannels.id, source.id));

            if (canPostOriginalLinkComment) {
              const anchor = items[0]?.message;
              const mirrorPostId = forwarded[0]?.id;
              if (anchor?.post && mirrorPostId) {
                const link = buildSourceMessageLink(source, anchor.id);
                void ensureOriginalLinkComment(this.client, {
                  mirrorEntity,
                  mirrorChannelId: mirror.id,
                  mirrorPostId,
                  sourceLink: link,
                });
              }
            }
            return;
          } catch (error2: unknown) {
            const msg2 = error2 instanceof Error ? error2.message : getTelegramErrorMessage(error2) ?? String(error2);
            await updateMessageMappingsByIds(
              mappingIds,
              { status: "failed", errorMessage: msg2, mirroredAt: new Date() },
              "realtime album retry failed",
            );
            return;
          }
        }
        if (waitSeconds && waitSeconds > FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
          const msg1 = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
          await pauseTask(taskId, msg1);
          return;
        }

        const msg1 = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        await updateMessageMappingsByIds(
          mappingIds,
          { status: "failed", errorMessage: msg1, mirroredAt: new Date() },
          "realtime album forward failed",
        );
      }
    };

    const bufferMediaGroup = (groupId: string, message: Api.Message, mappingId: string): void => {
      const existing = mediaGroupBuffers.get(groupId);
      if (existing) {
        existing.items.push({ message, mappingId });
        if (existing.timeout) clearTimeout(existing.timeout);
        existing.timeout = setTimeout(() => {
          flushMediaGroup(groupId).catch((e) => console.error("flush media group error:", e));
        }, mirrorBehavior.mediaGroupBufferMs);
        return;
      }

      const timeout = setTimeout(() => {
        flushMediaGroup(groupId).catch((e) => console.error("flush media group error:", e));
      }, mirrorBehavior.mediaGroupBufferMs);

      mediaGroupBuffers.set(groupId, { items: [{ message, mappingId }], timeout });
    };

    if (canSyncComments && discussionEntity) {
      const commentEventBuilder = new NewMessage({ chats: [sourceDiscussionChatFilter!] });
      try {
        await commentEventBuilder.resolve(this.client);

        const flushDiscussionMediaGroup = async (key: string): Promise<void> => {
          if (!(await ensureActive())) return;
          const entry = discussionMediaGroupBuffers.get(key);
          if (!entry) return;
          discussionMediaGroupBuffers.delete(key);
          if (entry.timeout) clearTimeout(entry.timeout);

          const album = [...entry.items].filter((m) => m instanceof Api.Message && m.id).sort((a, b) => a.id - b.id);
          const canSendAsAlbum = album.every((m) => m.media && !(m.media instanceof Api.MessageMediaWebPage));
          const link = buildSourceMessageLink(source, entry.sourcePostId);

          const sendSingle = async (m: Api.Message) => {
            const rawText = typeof m.message === "string" ? m.message : "";
            const formattingEntities = Array.isArray(m.entities) ? m.entities : undefined;
            if (!rawText.trim() && !m.media) return;

	              const sendOnce = async () => {
	                if (m.media && !(m.media instanceof Api.MessageMediaWebPage)) {
	                  await this.client.sendFile(mirrorEntity as EntityLike, {
	                    file: (getSendFileMediaForMessage(m) ?? m.media) as FileLike,
	                    caption: rawText,
	                    formattingEntities,
	                    commentTo: entry.mirrorPostId,
	                  });
	                  return;
	                }
	              if (rawText.trim()) {
	                await this.client.sendMessage(mirrorEntity as EntityLike, {
	                  message: rawText,
	                  formattingEntities,
	                  commentTo: entry.mirrorPostId,
	                });
	              }
	            };

            try {
              await sendOnce();
            } catch (error: unknown) {
              const waitSeconds = parseFloodWaitSeconds(error);
              if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
                await sleep(waitSeconds * 1000);
                await sendOnce();
              } else {
                throw error;
              }
            }
          };

          try {
            await ensureOriginalLinkComment(this.client, {
              mirrorEntity,
              mirrorChannelId: mirror.id,
              mirrorPostId: entry.mirrorPostId,
              sourceLink: link,
            });

            if (!canSendAsAlbum) {
              for (const m of album) {
                if (m.fwdFrom && m.fwdFrom.channelPost) continue;
                await sendSingle(m);
              }
              return;
            }

	            const files = album.map((m) => (getSendFileMediaForMessage(m) ?? m.media) as FileLike);
	            const captions = album.map((m) => (typeof m.message === "string" ? m.message : ""));

	            const sendOnce = async () => {
	              await this.client.sendFile(mirrorEntity as EntityLike, {
	                file: files,
	                caption: captions,
	                commentTo: entry.mirrorPostId,
	              });
	            };

            try {
              await sendOnce();
            } catch (error: unknown) {
              const waitSeconds = parseFloodWaitSeconds(error);
              if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
                await sleep(waitSeconds * 1000);
                await sendOnce();
              } else {
                throw error;
              }
            }
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
            console.error(`realtime comment album handler error: ${msg}`);

            for (const m of album) {
              try {
                if (m.fwdFrom && m.fwdFrom.channelPost) continue;
                await sendSingle(m);
              } catch (error2: unknown) {
                const msg2 = error2 instanceof Error ? error2.message : getTelegramErrorMessage(error2) ?? String(error2);
                console.error(`realtime comment mirror fallback failed: post=${entry.sourcePostId} comment=${m.id} - ${msg2}`);
              }
            }
          }
        };

        const bufferDiscussionMediaGroup = (
          groupKey: string,
          message: Api.Message,
          { mirrorPostId, sourcePostId }: { mirrorPostId: number; sourcePostId: number },
        ): void => {
          const key = `${sourcePostId}:${groupKey}`;
          const existing = discussionMediaGroupBuffers.get(key);
          if (existing) {
            existing.items.push(message);
            if (existing.timeout) clearTimeout(existing.timeout);
            existing.timeout = setTimeout(() => {
              flushDiscussionMediaGroup(key).catch((e) => console.error("flush discussion media group error:", e));
            }, mirrorBehavior.mediaGroupBufferMs);
            return;
          }

          const timeout = setTimeout(() => {
            flushDiscussionMediaGroup(key).catch((e) => console.error("flush discussion media group error:", e));
          }, mirrorBehavior.mediaGroupBufferMs);
          discussionMediaGroupBuffers.set(key, { items: [message], mirrorPostId, sourcePostId, timeout });
        };

        this.client.addEventHandler(
          async (event) => {
            try {
              if (!(await ensureActive())) return;
              const message = event.message;
              if (!(message instanceof Api.Message)) return;
              if (!message.id) return;
              if (mirroredDiscussionMessageIds.has(message.id)) return;
              if (mirroredDiscussionMessageIds.size > 5000) mirroredDiscussionMessageIds.clear();
              mirroredDiscussionMessageIds.add(message.id);

              if (message.fwdFrom && message.fwdFrom.channelPost) return;

	              const discussion = await this.client.invoke(
	                new Api.messages.GetDiscussionMessage({ peer: discussionEntity as EntityLike, msgId: message.id }),
	              );

	              const sourceChannelIdStr = source.telegramId ? String(source.telegramId) : "";
	              const discussionMessages = readArrayProp(discussion, "messages") ?? [];
	              const related = discussionMessages.find((m) => {
	                if (!(m instanceof Api.Message)) return false;
	                if (!(m.peerId instanceof Api.PeerChannel)) return false;
	                return m.peerId.channelId?.toString?.() === sourceChannelIdStr;
	              }) as Api.Message | undefined;
              if (!related?.id) return;

              const sourcePostId = related.id;
              const [postMapping] = await db
                .select({ mirrorMessageId: schema.messageMappings.mirrorMessageId })
                .from(schema.messageMappings)
                .where(
                  and(eq(schema.messageMappings.sourceChannelId, source.id), eq(schema.messageMappings.sourceMessageId, sourcePostId)),
                )
                .limit(1);

              const mirrorPostId = postMapping?.mirrorMessageId;
              if (!mirrorPostId) return;

              const rawText = typeof message.message === "string" ? message.message : "";
              const link = buildSourceMessageLink(source, sourcePostId);
              const formattingEntities = Array.isArray(message.entities) ? message.entities : undefined;

              const isAlbumItem = !!message.groupedId && !!message.media && !(message.media instanceof Api.MessageMediaWebPage);
              if (isAlbumItem) {
                bufferDiscussionMediaGroup(String(message.groupedId), message, { mirrorPostId, sourcePostId });
                return;
              }

              await ensureOriginalLinkComment(this.client, { mirrorEntity, mirrorChannelId: mirror.id, mirrorPostId, sourceLink: link });

	              const sendOnce = async () => {
	                if (message.media && !(message.media instanceof Api.MessageMediaWebPage)) {
	                  await this.client.sendFile(mirrorEntity as EntityLike, {
	                    file: (getSendFileMediaForMessage(message) ?? message.media) as FileLike,
	                    caption: rawText,
	                    formattingEntities,
	                    commentTo: mirrorPostId,
	                  });
	                  return;
	                }
	                if (rawText.trim()) {
	                  await this.client.sendMessage(mirrorEntity as EntityLike, {
	                    message: rawText,
	                    formattingEntities,
	                    commentTo: mirrorPostId,
	                  });
	                }
	              };

            try {
              await sendOnce();
            } catch (error: unknown) {
              const waitSeconds = parseFloodWaitSeconds(error);
              if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
                await sleep(waitSeconds * 1000);
                await sendOnce();
              } else {
                throw error;
              }
              }
            } catch (error: unknown) {
              const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
              console.error(`realtime comment handler error: ${msg}`);
            }
          },
          commentEventBuilder,
        );
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        console.warn(`comments sync disabled (failed to subscribe): ${msg}`);
      }
    }

    this.client.addEventHandler(
      async (event) => {
        try {
          if (!(await ensureActive())) return;
          const message = event.message;
          if (!(message instanceof Api.Message)) return;
          if (!message.id) return;

          const sentAt = new Date(message.date * 1000);
          const text = typeof message.message === "string" ? message.message : "";
          const textPreview = text.length > 200 ? `${text.slice(0, 200)}` : text;
          const messageType = messageTypeFromMessage(message);
          const mediaGroupId = message.groupedId ? String(message.groupedId) : null;
          const hasMedia = !!message.media;
          const fileSize = extractMediaFileSize(message);

          let initialStatus: (typeof schema.messageStatusEnum.enumValues)[number] = "pending";
          let initialSkipReason: (typeof schema.skipReasonEnum.enumValues)[number] | null = null;
          let initialErrorMessage: string | null = null;
          let initialMirroredAt: Date | null = null;

          if (hasMedia) {
            if (messageType === "video" && !mirrorBehavior.mirrorVideos) {
              initialStatus = "skipped";
              initialSkipReason = "unsupported_type";
              initialErrorMessage = "skipped: video disabled by settings";
              initialMirroredAt = new Date();
            } else if (
              mirrorBehavior.maxFileSizeBytes != null &&
              fileSize != null &&
              Number.isFinite(fileSize) &&
              fileSize > mirrorBehavior.maxFileSizeBytes
            ) {
              initialStatus = "skipped";
              initialSkipReason = "file_too_large";
              initialErrorMessage = `skipped: file too large (${Math.ceil(fileSize / 1024 / 1024)}MB > ${mirrorBehavior.maxFileSizeMb}MB)`;
              initialMirroredAt = new Date();
            }
          }

          const inserted = await withDbRetry(
            () =>
              db
                .insert(schema.messageMappings)
                .values({
                  sourceChannelId: source.id,
                  sourceMessageId: message.id,
                  mirrorChannelId: mirror.id,
                  messageType,
                  mediaGroupId,
                  status: initialStatus,
                  skipReason: initialSkipReason,
                  errorMessage: initialErrorMessage,
                  hasMedia,
                  fileSize: fileSize ?? null,
                  text: text || null,
                  textPreview: textPreview || null,
                  sentAt,
                  mirroredAt: initialMirroredAt,
                })
                .onConflictDoNothing()
                .returning({ id: schema.messageMappings.id }),
            `realtime upsert message_mapping (taskId=${taskId}, msgId=${message.id})`,
            { attempts: 3, baseDelayMs: 250 },
          );
          if (!inserted.length) return;

          const mappingId = inserted[0]!.id;

          if (initialStatus === "skipped") return;

          if (mode === "forward" && mirrorBehavior.groupMediaMessages && message.groupedId) {
            bufferMediaGroup(String(message.groupedId), message, mappingId);
            return;
          }

	          const markSkipped = async (skipReason: (typeof schema.skipReasonEnum.enumValues)[number]) => {
            if (skipReason === "protected_content" && !reportedProtectedContent) {
              reportedProtectedContent = true;
              console.warn(
                `source channel has protected content enabled; realtime forwarding is blocked. New messages will be marked skipped (or realtime task paused if skip_protected_content=false).`,
              );
              await logSyncEvent({
                sourceChannelId: source.id,
                level: "warn",
                message: `protected content enabled; realtime forwarding blocked (taskId=${taskId})`,
              });
            }
            if (skipReason === "protected_content" && !source.isProtected) {
              try {
                await withDbRetry(
                  () => db.update(schema.sourceChannels).set({ isProtected: true }).where(eq(schema.sourceChannels.id, source.id)),
                  `realtime mark source protected (taskId=${taskId}, sourceId=${source.id})`,
                  { attempts: 3, baseDelayMs: 250 },
                );
                source.isProtected = true;
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn(`failed to mark source channel protected: ${source.id} - ${msg}`);
              }
            }
            await withDbRetry(
              () =>
                db
                  .update(schema.messageMappings)
                  .set({ status: "skipped", skipReason, mirroredAt: new Date() })
                  .where(eq(schema.messageMappings.id, mappingId)),
              `realtime mark skipped (taskId=${taskId}, mappingId=${mappingId})`,
              { attempts: 3, baseDelayMs: 250 },
            );
	          };

          const messageFilter = await getEffectiveMessageFilterSettings(source.id);
          if (shouldSkipMessageByFilter(text, messageFilter)) {
            await markSkipped("filtered");
            return;
          }

	          const markProtectedContentBlocked = async (error: unknown): Promise<void> => {
            if (!reportedProtectedContent) {
              reportedProtectedContent = true;
              console.warn(
                `source channel has protected content enabled; realtime forwarding is blocked. New messages will be marked skipped (or realtime task paused if skip_protected_content=false).`,
              );
              await logSyncEvent({
                sourceChannelId: source.id,
                level: "warn",
                message: `protected content enabled; realtime forwarding blocked (taskId=${taskId})`,
              });
            }
            if (!source.isProtected) {
              try {
                await withDbRetry(
                  () => db.update(schema.sourceChannels).set({ isProtected: true }).where(eq(schema.sourceChannels.id, source.id)),
                  `realtime mark source protected (taskId=${taskId}, sourceId=${source.id})`,
                  { attempts: 3, baseDelayMs: 250 },
                );
                source.isProtected = true;
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn(`failed to mark source channel protected: ${source.id} - ${msg}`);
              }
            }

            const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
            await withDbRetry(
              () =>
                db
                  .update(schema.messageMappings)
                  .set({ status: "failed", skipReason: "protected_content", errorMessage: msg, mirroredAt: new Date() })
                  .where(eq(schema.messageMappings.id, mappingId)),
              `realtime mark protected blocked (taskId=${taskId}, mappingId=${mappingId})`,
              { attempts: 3, baseDelayMs: 250 },
            );

            await pauseTask(taskId, msg);
          };

          const markFailed = async (error: unknown) => {
            const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
            await withDbRetry(
              () =>
                db
                  .update(schema.messageMappings)
                  .set({ status: "failed", errorMessage: msg, mirroredAt: new Date() })
                  .where(eq(schema.messageMappings.id, mappingId)),
              `realtime mark failed (taskId=${taskId}, mappingId=${mappingId})`,
              { attempts: 3, baseDelayMs: 250 },
            );
          };

	          const markSuccess = async (mirrorMessageId: number | null) => {
	            await withDbRetry(
	              () =>
	                db
	                  .update(schema.messageMappings)
	                  .set({ status: "success", mirrorMessageId, mirroredAt: new Date(), errorMessage: null })
	                  .where(eq(schema.messageMappings.id, mappingId)),
	              `realtime mark success (taskId=${taskId}, mappingId=${mappingId})`,
	              { attempts: 3, baseDelayMs: 250 },
	            );

            await withDbRetry(
              () =>
                db
                  .update(schema.sourceChannels)
	                .set({ lastSyncAt: new Date(), lastMessageId: message.id })
	                .where(eq(schema.sourceChannels.id, source.id)),
              `realtime update source lastSyncAt (taskId=${taskId}, sourceId=${source.id})`,
              { attempts: 3, baseDelayMs: 250 },
            );
	          };

	          let mirroredMessage: Api.Message | null = null;

		          const tryMirrorOnce = async (): Promise<number | null> => {
		            if (mode === "copy") {
		              mirroredMessage = null;
		              const content = text.trim();
		              if (!content) throw new Error("unsupported_type: empty text in copy mode");
		              const sent = await this.client.sendMessage(mirrorEntity, { message: content });
		              await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);
		              return sent?.id ?? null;
		            }
		            const forwarded = await forwardMessagesAsCopy(this.client, {
		              fromPeer: sourceEntity,
		              toPeer: mirrorEntity,
		              messageIds: [message.id],
		            });
		            await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);
		            const m = forwarded[0];
		            if (!m?.id) throw new Error("missing forwarded message mapping");
		            mirroredMessage = m;
		            return m.id;
		          };

          try {
            if (mode === "copy") {
              const content = text.trim();
              if (!content) {
                await markSkipped("unsupported_type");
                return;
              }
            }
	
	            const mirrorMessageId = await tryMirrorOnce();
	            await markSuccess(mirrorMessageId);

	            if (mode === "forward" && mirrorMessageId) {
	              await ensureMirrorMessageSpoiler(this.client, {
	                mirrorPeer: mirrorEntity,
	                mirrorMessageId,
	                sourceMessage: message,
	                mirroredMessage,
	              });
	            }
	
	            if (canPostOriginalLinkComment && mirrorMessageId && message.post) {
	              const link = buildSourceMessageLink(source, message.id);
	              void ensureOriginalLinkComment(this.client, {
                mirrorEntity,
                mirrorChannelId: mirror.id,
                mirrorPostId: mirrorMessageId,
                sourceLink: link,
              });
            }
          } catch (error: unknown) {
            const { skipReason } = classifyMirrorError(error);
            if (skipReason) {
              if (skipReason === "protected_content" && !mirrorBehavior.skipProtectedContent) {
                await markProtectedContentBlocked(error);
                return;
              }
              await markSkipped(skipReason);
              return;
            }

            const waitSeconds = parseFloodWaitSeconds(error);
            if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
              await sleep(waitSeconds * 1000);
	              try {
	                const mirrorMessageId = await tryMirrorOnce();
	                await markSuccess(mirrorMessageId);

	                if (mode === "forward" && mirrorMessageId) {
	                  await ensureMirrorMessageSpoiler(this.client, {
	                    mirrorPeer: mirrorEntity,
	                    mirrorMessageId,
	                    sourceMessage: message,
	                    mirroredMessage,
	                  });
	                }
	
	                if (canPostOriginalLinkComment && mirrorMessageId && message.post) {
	                  const link = buildSourceMessageLink(source, message.id);
	                  void ensureOriginalLinkComment(this.client, {
                    mirrorEntity,
                    mirrorChannelId: mirror.id,
                    mirrorPostId: mirrorMessageId,
                    sourceLink: link,
                  });
                }
                return;
              } catch (error2: unknown) {
                const { skipReason: skipReason2 } = classifyMirrorError(error2);
                if (skipReason2) {
                  if (skipReason2 === "protected_content" && !mirrorBehavior.skipProtectedContent) {
                    await markProtectedContentBlocked(error2);
                    return;
                  }
                  await markSkipped(skipReason2);
                  return;
                }
                await markFailed(error2);
                return;
              }
            }

            if (waitSeconds && waitSeconds > FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
              const msg1 = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
              await pauseTask(taskId, msg1);
            }
            await markFailed(error);
          }
        } catch (error: unknown) {
          console.error("realtime handler error:", error);
        }
      },
      eventBuilder,
    );

    await withDbRetry(
      () => db.update(schema.syncTasks).set({ status: "running", startedAt: new Date() }).where(eq(schema.syncTasks.id, taskId)),
      `realtime mark task running (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
    void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "realtime", status: "running" });

    this.subscriptions.set(sourceChannelId, { sourceChannelId, mirrorChannelId: mirror.id });
    console.log(`realtime subscribed: source=${source.channelIdentifier} -> mirror=${mirror.channelIdentifier}`);
    await logSyncEvent({
      sourceChannelId: source.id,
      level: "info",
      message: `realtime subscribed -> mirror=${mirror.channelIdentifier} (taskId=${taskId})`,
    });
  }
}
  return new RealtimeManager(client);
}
