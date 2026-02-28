import { schema } from "@tg-back/db";
import { Api } from "telegram";
import { readArrayProp, readProp } from "./object-props";
import { getTelegramErrorMessage } from "./telegram-errors";

export function messageTypeFromMessage(message: Api.Message): (typeof schema.messageTypeEnum.enumValues)[number] {
  if (!message.media) return "text";

  if (message.media instanceof Api.MessageMediaPhoto) return "photo";
  if (message.media instanceof Api.MessageMediaDocument) {
    const document = message.media.document;
    if (document instanceof Api.Document) {
      for (const attr of document.attributes) {
        if (attr instanceof Api.DocumentAttributeVideo) return "video";
        if (attr instanceof Api.DocumentAttributeAnimated) return "animation";
        if (attr instanceof Api.DocumentAttributeSticker) return "sticker";
        if (attr instanceof Api.DocumentAttributeAudio) return attr.voice ? "voice" : "audio";
      }
    }
    return "document";
  }

  return "other";
}

export function extractMediaFileSize(message: Api.Message): number | null {
  const media = message.media;
  if (!media) return null;
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document as unknown;
    const size = readProp(doc, "size");
    if (typeof size === "number" && Number.isFinite(size) && size >= 0) return Math.floor(size);
    if (typeof size === "bigint") return Number(size);
  }
  if (media instanceof Api.MessageMediaPhoto) {
    const photo = readProp(media, "photo");
    const sizes = readArrayProp(photo, "sizes");
    if (!sizes) return null;
    let max = 0;
    for (const s of sizes) {
      if (!s || typeof s !== "object") continue;
      const value = readProp(s, "size") ?? readProp(s, "bytes");
      if (typeof value === "number" && Number.isFinite(value) && value > max) max = value;
    }
    return max > 0 ? max : null;
  }
  return null;
}

export function classifyMirrorError(error: unknown): { skipReason?: (typeof schema.skipReasonEnum.enumValues)[number] } {
  const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
  if (msg.includes("FORWARDS_RESTRICTED") || msg.includes("CHAT_FORWARDS_RESTRICTED")) {
    return { skipReason: "protected_content" };
  }
  if (msg.includes("MESSAGE_ID_INVALID") || msg.includes("MESSAGE_NOT_FOUND")) {
    return { skipReason: "message_deleted" };
  }
  return {};
}
