import { Api, TelegramClient } from "telegram";
import { toBigIntOrNull } from "./bigint";
import { readArrayProp, readBooleanProp, readNumberProp, readProp, readStringProp } from "./object-props";
import { getTelegramErrorMessage } from "./telegram-errors";
import { buildCanonicalChannelIdentifier } from "./telegram-identifiers";

export async function getLinkedDiscussionChatFilter(client: TelegramClient, channelEntity: unknown): Promise<string | null> {
  if (!(channelEntity instanceof Api.Channel)) return null;
  try {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: channelEntity }));
    const fullChat = readProp(full, "fullChat");
    if (fullChat instanceof Api.ChannelFull && fullChat.linkedChatId) {
      return `-100${fullChat.linkedChatId.toString()}`;
    }
  } catch (error: unknown) {
    if (!isChannelInaccessibleError(error)) {
      const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
      console.warn(`failed to fetch linked discussion chat: ${msg}`);
    }
  }
  return null;
}

export type SourceChannelMetadata = {
  description?: string | null;
  memberCount?: number | null;
  isProtected?: boolean;
};

export async function getSourceChannelMetadata(client: TelegramClient, channelEntity: unknown): Promise<SourceChannelMetadata> {
  if (!(channelEntity instanceof Api.Channel)) return {};

  const out: SourceChannelMetadata = {};

  const noforwards = readBooleanProp(channelEntity, "noforwards");
  if (noforwards !== undefined) out.isProtected = noforwards;

  try {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: channelEntity }));
    const fullChat = readProp(full, "fullChat");
    if (fullChat instanceof Api.ChannelFull) {
      const about = readStringProp(fullChat, "about");
      if (typeof about === "string") {
        const trimmed = about.trim();
        out.description = trimmed ? trimmed : null;
      }

      const participantsCount = readNumberProp(fullChat, "participantsCount");
      if (typeof participantsCount === "number") out.memberCount = Math.max(0, Math.floor(participantsCount));
    }
  } catch (error: unknown) {
    if (!isChannelInaccessibleError(error)) {
      const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
      console.warn(`failed to fetch channel metadata: ${msg}`);
    }
  }

  return out;
}

export function isChannelInaccessibleError(error: unknown): boolean {
  const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
  if (!msg) return false;

  const codes = [
    "CHANNEL_PRIVATE",
    "CHANNEL_INVALID",
    "CHANNEL_PUBLIC_GROUP_NA",
    "INVITE_HASH_EXPIRED",
    "INVITE_HASH_INVALID",
    "USERNAME_NOT_OCCUPIED",
    "PEER_ID_INVALID",
    "CHAT_ID_INVALID",
    "USER_BANNED_IN_CHANNEL",
    "USER_BANNED",
    "AUTH_KEY_UNREGISTERED",
  ];

  return codes.some((code) => msg.includes(code));
}

export function extractSourceChannelMetadataFromChatFull(
  result: unknown,
  channelTelegramId: bigint,
): SourceChannelMetadata & {
  name?: string;
  username?: string | null;
  accessHash?: bigint | null;
  channelIdentifier?: string;
} {
  const out: SourceChannelMetadata & {
    name?: string;
    username?: string | null;
    accessHash?: bigint | null;
    channelIdentifier?: string;
  } = {};

  if (!(result instanceof Api.messages.ChatFull)) return out;

  const fullChat = readProp(result, "fullChat");
  if (fullChat instanceof Api.ChannelFull) {
    const about = readStringProp(fullChat, "about");
    if (typeof about === "string") {
      const trimmed = about.trim();
      out.description = trimmed ? trimmed : null;
    }

    const participantsCount = readNumberProp(fullChat, "participantsCount");
    if (typeof participantsCount === "number") out.memberCount = Math.max(0, Math.floor(participantsCount));
  }

  const chats = readArrayProp(result, "chats");
  if (chats) {
    for (const chat of chats) {
      if (!(chat instanceof Api.Channel)) continue;
      const id = toBigIntOrNull(readProp(chat, "id"));
      if (id !== channelTelegramId) continue;

      const title = readStringProp(chat, "title");
      out.name = title && title.trim() ? title.trim() : undefined;

      const username = readStringProp(chat, "username");
      out.username = username && username.trim() ? username.trim() : null;

      out.accessHash = toBigIntOrNull(readProp(chat, "accessHash"));
      const isProtected = readBooleanProp(chat, "noforwards");
      if (isProtected !== undefined) out.isProtected = isProtected;

      const canonical = buildCanonicalChannelIdentifier(
        { peerType: "channel", telegramId: channelTelegramId, username: out.username ?? null },
        `-100${channelTelegramId.toString()}`,
      );
      out.channelIdentifier = canonical;
      break;
    }
  }

  return out;
}
