import { Api, TelegramClient } from "telegram";
import type { EntityLike } from "telegram/define";
import { toBigIntOrNull } from "./bigint";
import { readArrayProp, readProp } from "./object-props";
import { normalizeChatIdentifier, parseTelegramInviteHash } from "./telegram-identifiers";

export type ResolvedPeer = {
  peerType: "channel" | "chat" | "user" | "other";
  telegramId: bigint | null;
  accessHash: bigint | null;
  name: string;
  username: string | null;
  entity: EntityLike;
};

export async function resolvePeer(client: TelegramClient, identifier: string): Promise<ResolvedPeer> {
  const inviteHash = parseTelegramInviteHash(identifier);
  if (inviteHash) {
    const checked = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));

    if (checked instanceof Api.ChatInviteAlready) {
      const entity = readProp(checked, "chat");
      if (entity instanceof Api.Channel) {
        return {
          peerType: "channel",
          telegramId: toBigIntOrNull(entity.id),
          accessHash: toBigIntOrNull(entity.accessHash),
          name: entity.title ?? identifier,
          username: entity.username ?? null,
          entity,
        };
      }
      if (entity instanceof Api.Chat) {
        return {
          peerType: "chat",
          telegramId: toBigIntOrNull(entity.id),
          accessHash: null,
          name: entity.title ?? identifier,
          username: null,
          entity,
        };
      }
    }

    if (checked instanceof Api.ChatInvite) {
      const imported = await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
      const chats = readArrayProp(imported, "chats");
      const entity = chats ? chats.find((c) => c instanceof Api.Channel || c instanceof Api.Chat) : null;
      if (entity instanceof Api.Channel) {
        return {
          peerType: "channel",
          telegramId: toBigIntOrNull(entity.id),
          accessHash: toBigIntOrNull(entity.accessHash),
          name: entity.title ?? checked.title ?? identifier,
          username: entity.username ?? null,
          entity,
        };
      }
      if (entity instanceof Api.Chat) {
        return {
          peerType: "chat",
          telegramId: toBigIntOrNull(entity.id),
          accessHash: null,
          name: entity.title ?? checked.title ?? identifier,
          username: null,
          entity,
        };
      }

      throw new Error(`failed to import invite (no chat entity found): ${identifier}`);
    }

    throw new Error(`failed to resolve invite: ${identifier}`);
  }

  const normalized = normalizeChatIdentifier(identifier);
  const entity = await client.getEntity(normalized);

  if (entity instanceof Api.Channel) {
    return {
      peerType: "channel",
      telegramId: toBigIntOrNull(entity.id),
      accessHash: toBigIntOrNull(entity.accessHash),
      name: entity.title ?? identifier,
      username: entity.username ?? null,
      entity,
    };
  }
  if (entity instanceof Api.User) {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ").trim();
    return {
      peerType: "user",
      telegramId: toBigIntOrNull(entity.id),
      accessHash: toBigIntOrNull(entity.accessHash),
      name: name || entity.username || identifier,
      username: entity.username ?? null,
      entity,
    };
  }
  if (entity instanceof Api.Chat) {
    return {
      peerType: "chat",
      telegramId: toBigIntOrNull(entity.id),
      accessHash: null,
      name: entity.title ?? identifier,
      username: null,
      entity,
    };
  }

  return {
    peerType: "other",
    telegramId: null,
    accessHash: null,
    name: identifier,
    username: null,
    entity,
  };
}
