import { Api, TelegramClient } from "telegram";
import type { EntityLike, FileLike } from "telegram/define";
import { sleep } from "../utils/sleep";
import { getTelegramErrorMessage, parseFloodWaitSeconds } from "./telegram-errors";
import { buildSourceMessageLink } from "./telegram-identifiers";
import { ensureOriginalLinkComment } from "./telegram-original-link";
import { getSendFileMediaForMessage } from "./telegram-spoiler";

type CommentSyncOptions = {
  floodWaitAutoSleepMaxSec: number;
};

export async function syncCommentsForPost(
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
  options: CommentSyncOptions,
): Promise<void> {
  if (maxComments <= 0) return;
  const link = buildSourceMessageLink(sourceChannel, sourcePostId);
  let processed = 0;

  try {
    await ensureOriginalLinkComment(client, { mirrorEntity, mirrorChannelId, mirrorPostId, sourceLink: link }, options);

    const sendSingle = async (m: Api.Message) => {
      if (!m.id) return;
      if (m.fwdFrom && m.fwdFrom.channelPost) return;

      const rawText = typeof m.message === "string" ? m.message : "";
      const formattingEntities = Array.isArray(m.entities) ? m.entities : undefined;
      if (!rawText.trim() && !m.media) return;

      const sendOnce = async () => {
        if (m.media && !(m.media instanceof Api.MessageMediaWebPage)) {
          await client.sendFile(mirrorEntity as EntityLike, {
            file: (getSendFileMediaForMessage(m) ?? m.media) as FileLike,
            caption: rawText,
            formattingEntities,
            commentTo: mirrorPostId,
          });
          return;
        }

        if (!rawText.trim()) return;
        await client.sendMessage(mirrorEntity as EntityLike, { message: rawText, formattingEntities, commentTo: mirrorPostId });
      };

      try {
        await sendOnce();
      } catch (error: unknown) {
        const waitSeconds = parseFloodWaitSeconds(error);
        if (waitSeconds && waitSeconds <= options.floodWaitAutoSleepMaxSec) {
          await sleep(waitSeconds * 1000);
          try {
            await sendOnce();
          } catch (error2: unknown) {
            const msg2 = error2 instanceof Error ? error2.message : getTelegramErrorMessage(error2) ?? String(error2);
            console.error(`comment mirror failed: post=${sourcePostId} comment=${m.id} - ${msg2}`);
          }
        } else {
          const msg1 = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
          console.error(`comment mirror failed: post=${sourcePostId} comment=${m.id} - ${msg1}`);
        }
      }
    };

    let pendingAlbum: Api.Message[] = [];
    let pendingAlbumGroupId: string | null = null;

    const flushAlbum = async () => {
      if (!pendingAlbum.length) return;
      const groupId = pendingAlbumGroupId;
      const album = [...pendingAlbum].sort((a, b) => a.id - b.id);
      pendingAlbum = [];
      pendingAlbumGroupId = null;

      const canSendAsAlbum = album.every((m) => m.id && m.media && !(m.media instanceof Api.MessageMediaWebPage));
      if (!canSendAsAlbum) {
        for (const m of album) {
          await sendSingle(m);
        }
        return;
      }

      const files = album.map((m) => (getSendFileMediaForMessage(m) ?? m.media) as FileLike);
      const captions = album.map((m) => (typeof m.message === "string" ? m.message : ""));

      const sendOnce = async () => {
        await client.sendFile(mirrorEntity as EntityLike, {
          file: files,
          caption: captions,
          commentTo: mirrorPostId,
        });
      };

      try {
        await sendOnce();
      } catch (error: unknown) {
        const waitSeconds = parseFloodWaitSeconds(error);
        if (waitSeconds && waitSeconds <= options.floodWaitAutoSleepMaxSec) {
          await sleep(waitSeconds * 1000);
          try {
            await sendOnce();
            return;
          } catch (error2: unknown) {
            const msg2 = error2 instanceof Error ? error2.message : getTelegramErrorMessage(error2) ?? String(error2);
            console.error(`comment album mirror failed: post=${sourcePostId} groupedId=${groupId ?? "unknown"} - ${msg2}`);
          }
        } else {
          const msg1 = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
          console.error(`comment album mirror failed: post=${sourcePostId} groupedId=${groupId ?? "unknown"} - ${msg1}`);
        }

        for (const m of album) {
          await sendSingle(m);
        }
      }
    };

    for await (const m of client.iterMessages(sourceEntity as EntityLike, { replyTo: sourcePostId, reverse: true, waitTime: 1 })) {
      if (!(m instanceof Api.Message)) continue;
      if (!m.id) continue;
      if (m.fwdFrom && m.fwdFrom.channelPost) continue;

      const isAlbumItem = !!m.groupedId && !!m.media && !(m.media instanceof Api.MessageMediaWebPage);
      const groupId = isAlbumItem ? String(m.groupedId) : null;
      if (pendingAlbum.length && groupId !== pendingAlbumGroupId) {
        await flushAlbum();
      }

      if (isAlbumItem && groupId) {
        pendingAlbumGroupId = groupId;
        pendingAlbum.push(m);
      } else {
        await flushAlbum();
        await sendSingle(m);
      }

      processed += 1;
      if (processed >= maxComments) break;
    }

    await flushAlbum();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
    console.error(`sync comments failed for post=${sourcePostId}: ${msg}`);
  }
}
