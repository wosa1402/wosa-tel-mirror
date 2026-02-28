import { Api, TelegramClient } from "telegram";
import { getInputMedia } from "telegram/Utils";
import type { EntityLike } from "telegram/define";
import { sleep } from "../utils/sleep";
import { getTelegramErrorMessage, parseFloodWaitSeconds } from "./telegram-errors";

type MirrorSpoilerOptions = {
  floodWaitAutoSleepMaxSec: number;
};

function mediaHasSpoiler(media: unknown): boolean {
  if (!media || typeof media !== "object") return false;
  return (media as { spoiler?: unknown }).spoiler === true;
}

function buildInputMediaWithSpoiler(media: unknown): Api.TypeInputMedia | null {
  if (!mediaHasSpoiler(media)) return null;
  try {
    const input = getInputMedia(media);
    if (input && typeof input === "object") (input as { spoiler?: boolean }).spoiler = true;
    return input;
  } catch {
    return null;
  }
}

export function getSendFileMediaForMessage(message: Api.Message): unknown {
  const media = message.media;
  if (!media || media instanceof Api.MessageMediaWebPage) return null;
  return buildInputMediaWithSpoiler(media) ?? media;
}

export async function ensureMirrorMessageSpoiler(
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
  options: MirrorSpoilerOptions,
): Promise<void> {
  const sourceMedia = sourceMessage.media;
  if (!sourceMedia || sourceMedia instanceof Api.MessageMediaWebPage) return;
  if (!mediaHasSpoiler(sourceMedia)) return;

  const mirrorMedia = mirroredMessage?.media;
  if (mirrorMedia && mediaHasSpoiler(mirrorMedia)) return;

  const inputMedia = buildInputMediaWithSpoiler(sourceMedia);
  if (!inputMedia) return;

  const rawText = typeof sourceMessage.message === "string" ? sourceMessage.message : "";
  const entities = Array.isArray(sourceMessage.entities) ? sourceMessage.entities : undefined;
  const mirrorPeerInput = await client.getInputEntity(mirrorPeer as EntityLike);

  const editOnce = async () => {
    await client.invoke(
      new Api.messages.EditMessage({
        peer: mirrorPeerInput,
        id: mirrorMessageId,
        media: inputMedia,
        message: rawText ? rawText : undefined,
        entities: rawText && entities ? entities : undefined,
      }),
    );
  };

  try {
    await editOnce();
  } catch (error: unknown) {
    const waitSeconds = parseFloodWaitSeconds(error);
    if (waitSeconds && waitSeconds <= options.floodWaitAutoSleepMaxSec) {
      await sleep(waitSeconds * 1000);
      try {
        await editOnce();
      } catch (error2: unknown) {
        const msg2 = error2 instanceof Error ? error2.message : getTelegramErrorMessage(error2) ?? String(error2);
        console.warn(`failed to apply spoiler to mirrored message: ${mirrorMessageId} - ${msg2}`);
      }
      return;
    }

    const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
    console.warn(`failed to apply spoiler to mirrored message: ${mirrorMessageId} - ${msg}`);
  }
}
