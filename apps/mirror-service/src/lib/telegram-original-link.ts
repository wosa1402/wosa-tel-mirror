import { TelegramClient } from "telegram";
import { sleep } from "../utils/sleep";
import { getTelegramErrorMessage, isRetryableCommentThreadError, parseFloodWaitSeconds } from "./telegram-errors";
import { formatOriginalLinkComment } from "./telegram-identifiers";

const originalLinkCommentKeys = new Set<string>();

type OriginalLinkCommentOptions = {
  floodWaitAutoSleepMaxSec: number;
};

export async function ensureOriginalLinkComment(
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
  options: OriginalLinkCommentOptions,
): Promise<void> {
  if (!sourceLink) return;

  const key = `${mirrorChannelId}:${mirrorPostId}`;
  if (originalLinkCommentKeys.has(key)) return;
  if (originalLinkCommentKeys.size > 10_000) originalLinkCommentKeys.clear();

  const sendOnce = async () => {
    type SendMessagePeer = Parameters<TelegramClient["sendMessage"]>[0];
    await client.sendMessage(mirrorEntity as SendMessagePeer, {
      message: formatOriginalLinkComment(sourceLink),
      commentTo: mirrorPostId,
      linkPreview: false,
    });
  };

  const delaysMs = [0, 250, 750, 1500, 2500];
  let lastError: unknown = null;

  for (const delayMs of delaysMs) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      await sendOnce();
      originalLinkCommentKeys.add(key);
      return;
    } catch (error: unknown) {
      lastError = error;
      const waitSeconds = parseFloodWaitSeconds(error);
      if (waitSeconds && waitSeconds <= options.floodWaitAutoSleepMaxSec) {
        await sleep(waitSeconds * 1000);
        continue;
      }
      if (isRetryableCommentThreadError(error)) {
        continue;
      }
      const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
      console.warn(`failed to post original link comment: ${msg}`);
      return;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : getTelegramErrorMessage(lastError) ?? String(lastError);
  console.warn(`failed to post original link comment after retries: ${msg}`);
}
