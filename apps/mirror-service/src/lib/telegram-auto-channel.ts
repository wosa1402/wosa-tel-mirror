import { Api, TelegramClient } from "telegram";
import { returnBigInt } from "telegram/Helpers";
import { schema } from "@tg-back/db";
import type { EntityLike } from "telegram/define";
import { sleep } from "../utils/sleep";
import { toBigIntOrNull } from "./bigint";
import { logSyncEvent } from "./sync-events";
import { getTelegramErrorMessage, parseFloodWaitSeconds } from "./telegram-errors";
import { getLinkedDiscussionChatFilter } from "./telegram-metadata";
import { resolvePeer } from "./telegram-peer";
import { getAutoChannelSettings, normalizeUserIdentifier } from "./settings";

type TelegramAutoChannelOptions = {
  floodWaitAutoSleepMaxSec: number;
};

const autoChannelAdminKeys = new Set<string>();

export function extractFirstChannelFromUpdates(result: unknown): Api.Channel | null {
  const chats: unknown = result && typeof result === "object" && "chats" in result ? (result as { chats?: unknown }).chats : undefined;
  if (!Array.isArray(chats)) return null;
  for (const chat of chats) {
    if (chat instanceof Api.Channel) return chat;
  }
  return null;
}

export function extractInviteLinkFromExportedChatInvite(invite: unknown): string | null {
  if (invite instanceof Api.ChatInviteExported) {
    return typeof invite.link === "string" && invite.link.trim() ? invite.link.trim() : null;
  }
  if (invite && typeof invite === "object" && "link" in invite) {
    const maybe = (invite as { link?: unknown }).link;
    return typeof maybe === "string" && maybe.trim() ? maybe.trim() : null;
  }
  return null;
}

export function buildAutoMirrorTitle(prefix: string, sourceName: string): string {
  const p = prefix.trim() ? prefix : schema.defaultSettings.auto_channel_prefix;
  const base = sourceName.trim() ? sourceName.trim() : "tg-back";
  const combined = `${p}${base}`.trim();
  if (!combined) return "tg-back";
  if (combined.length <= 120) return combined;
  return combined.slice(0, 119) + "…";
}

function buildAutoDiscussionGroupTitle(prefix: string, sourceName: string): string {
  const base = buildAutoMirrorTitle(prefix, sourceName);
  const suffix = " 评论区";
  const combined = `${base}${suffix}`.trim();
  if (combined.length <= 120) return combined;
  const maxBaseLen = Math.max(1, 120 - suffix.length);
  const trimmedBase = base.length > maxBaseLen ? base.slice(0, maxBaseLen - 1) + "…" : base;
  return `${trimmedBase}${suffix}`.trim();
}

function buildFullAdminRights(): Api.ChatAdminRights {
  return new Api.ChatAdminRights({
    changeInfo: true,
    postMessages: true,
    editMessages: true,
    deleteMessages: true,
    banUsers: true,
    inviteUsers: true,
    pinMessages: true,
    addAdmins: true,
    anonymous: true,
    manageCall: true,
    other: true,
    manageTopics: true,
    postStories: true,
    editStories: true,
    deleteStories: true,
  });
}

function isUserAlreadyParticipantError(error: unknown): boolean {
  const msg = getTelegramErrorMessage(error);
  if (!msg) return false;
  return msg === "USER_ALREADY_PARTICIPANT";
}

function toInputUserFromInputPeer(peer: Api.TypeInputPeer): Api.TypeInputUser | null {
  if (peer instanceof Api.InputPeerUser) {
    return new Api.InputUser({ userId: peer.userId, accessHash: peer.accessHash });
  }
  if (peer instanceof Api.InputPeerSelf) {
    return new Api.InputUserSelf();
  }
  if (peer instanceof Api.InputPeerUserFromMessage) {
    return new Api.InputUserFromMessage({ peer: peer.peer, msgId: peer.msgId, userId: peer.userId });
  }
  return null;
}

async function resolveInputUserForAdmin(client: TelegramClient, identifier: string): Promise<Api.TypeInputUser | null> {
  const normalized = normalizeUserIdentifier(identifier);
  if (!normalized) return null;

  try {
    type GetInputEntityArg = Parameters<TelegramClient["getInputEntity"]>[0];
    const peer = (await client.getInputEntity(normalized as GetInputEntityArg)) as Api.TypeInputPeer;
    const inputUser = toInputUserFromInputPeer(peer);
    if (inputUser) return inputUser;
  } catch {
    // ignore and fallback
  }

  try {
    const entity = await client.getEntity(normalized as EntityLike);
    if (entity instanceof Api.User) {
      const userId = toBigIntOrNull(entity.id);
      const accessHash = toBigIntOrNull(entity.accessHash);
      if (userId != null && accessHash != null) {
        return new Api.InputUser({ userId: returnBigInt(userId), accessHash: returnBigInt(accessHash) });
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export async function ensureAutoChannelAdmins(
  client: TelegramClient,
  {
    sourceChannelId,
    channel,
    channelLabel,
    adminIdentifiers,
  }: { sourceChannelId: string; channel: Api.Channel; channelLabel: string; adminIdentifiers: string[] },
  options: TelegramAutoChannelOptions,
): Promise<void> {
  if (!adminIdentifiers.length) return;

  const rights = buildFullAdminRights();
  const channelId = toBigIntOrNull(channel.id)?.toString() ?? channelLabel;

  for (const raw of adminIdentifiers) {
    const adminIdentifier = raw.trim();
    if (!adminIdentifier) continue;

    const dedupeKey = `${channelId}:${adminIdentifier}`;
    if (autoChannelAdminKeys.has(dedupeKey)) continue;
    if (autoChannelAdminKeys.size > 10_000) autoChannelAdminKeys.clear();

    const user = await resolveInputUserForAdmin(client, adminIdentifier);
    if (!user) {
      const msg = `auto channel admin resolve failed: ${adminIdentifier} (channel=${channelLabel})`;
      console.warn(msg);
      await logSyncEvent({ sourceChannelId, level: "warn", message: msg });
      continue;
    }

    const inviteOnce = async () => {
      await client.invoke(
        new Api.channels.InviteToChannel({
          channel,
          users: [user],
        }),
      );
    };

    try {
      await inviteOnce();
    } catch (error: unknown) {
      if (!isUserAlreadyParticipantError(error)) {
        const waitSeconds = parseFloodWaitSeconds(error);
        if (waitSeconds && waitSeconds <= options.floodWaitAutoSleepMaxSec) {
          await sleep(waitSeconds * 1000);
          try {
            await inviteOnce();
          } catch (error2: unknown) {
            if (!isUserAlreadyParticipantError(error2)) {
              const msg2 = getTelegramErrorMessage(error2) ?? (error2 instanceof Error ? error2.message : String(error2));
              console.warn(`auto channel invite failed: ${adminIdentifier} -> ${channelLabel} - ${msg2}`);
              await logSyncEvent({
                sourceChannelId,
                level: "warn",
                message: `auto channel invite failed: ${adminIdentifier} -> ${channelLabel} - ${msg2}`,
              });
            }
          }
        } else {
          const msg1 = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
          console.warn(`auto channel invite failed: ${adminIdentifier} -> ${channelLabel} - ${msg1}`);
          await logSyncEvent({
            sourceChannelId,
            level: "warn",
            message: `auto channel invite failed: ${adminIdentifier} -> ${channelLabel} - ${msg1}`,
          });
        }
      }
    }

    const promoteOnce = async () => {
      await client.invoke(
        new Api.channels.EditAdmin({
          channel,
          userId: user,
          adminRights: rights,
          rank: "admin",
        }),
      );
    };

    try {
      await promoteOnce();
      autoChannelAdminKeys.add(dedupeKey);
      const msg = `auto channel admin granted: ${adminIdentifier} -> ${channelLabel}`;
      console.log(msg);
      await logSyncEvent({ sourceChannelId, level: "info", message: msg });
    } catch (error: unknown) {
      const waitSeconds = parseFloodWaitSeconds(error);
      if (waitSeconds && waitSeconds <= options.floodWaitAutoSleepMaxSec) {
        await sleep(waitSeconds * 1000);
        try {
          await promoteOnce();
          autoChannelAdminKeys.add(dedupeKey);
          const msg = `auto channel admin granted: ${adminIdentifier} -> ${channelLabel}`;
          console.log(msg);
          await logSyncEvent({ sourceChannelId, level: "info", message: msg });
        } catch (error2: unknown) {
          const msg2 = getTelegramErrorMessage(error2) ?? (error2 instanceof Error ? error2.message : String(error2));
          console.warn(`auto channel promote failed: ${adminIdentifier} -> ${channelLabel} - ${msg2}`);
          await logSyncEvent({
            sourceChannelId,
            level: "warn",
            message: `auto channel promote failed: ${adminIdentifier} -> ${channelLabel} - ${msg2}`,
          });
        }
        continue;
      }

      const msg1 = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
      console.warn(`auto channel promote failed: ${adminIdentifier} -> ${channelLabel} - ${msg1}`);
      await logSyncEvent({
        sourceChannelId,
        level: "warn",
        message: `auto channel promote failed: ${adminIdentifier} -> ${channelLabel} - ${msg1}`,
      });
    }
  }
}

export async function ensureDiscussionGroupForAutoMirrorChannel(
  client: TelegramClient,
  {
    sourceChannelId,
    sourceIdentifier,
    sourceName,
    mirrorChannel,
  }: {
    sourceChannelId: string;
    sourceIdentifier: string;
    sourceName: string;
    mirrorChannel: Api.Channel;
  },
  options: TelegramAutoChannelOptions,
): Promise<string | null> {
  const existing = await getLinkedDiscussionChatFilter(client, mirrorChannel);
  if (existing) {
    const auto = await getAutoChannelSettings();
    if (auto.admins.length) {
      try {
        const resolved = await resolvePeer(client, existing);
        if (resolved.entity instanceof Api.Channel) {
          await ensureAutoChannelAdmins(
            client,
            {
              sourceChannelId,
              channel: resolved.entity,
              channelLabel: `discussion group ${existing}`,
              adminIdentifiers: auto.admins,
            },
            options,
          );
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        console.warn(`failed to ensure discussion group admins: ${msg}`);
      }
    }
    return existing;
  }

  const auto = await getAutoChannelSettings();
  const groupTitle = buildAutoDiscussionGroupTitle(auto.prefix, sourceName || sourceIdentifier);
  const groupAbout = `tg-back discussion for ${sourceIdentifier}`;

  const createdGroupUpdates = await client.invoke(
    new Api.channels.CreateChannel({
      megagroup: true,
      title: groupTitle,
      about: groupAbout,
    }),
  );

  const createdGroup = extractFirstChannelFromUpdates(createdGroupUpdates);
  if (!createdGroup) throw new Error("failed to create discussion group: no channel entity in updates");

  await client.invoke(
    new Api.channels.SetDiscussionGroup({
      broadcast: mirrorChannel,
      group: createdGroup,
    }),
  );

  if (auto.admins.length) {
    const groupId = toBigIntOrNull(createdGroup.id);
    const label = groupId && groupId > 0n ? `-100${groupId.toString()}` : createdGroup.title ?? groupTitle;
    await ensureAutoChannelAdmins(
      client,
      {
        sourceChannelId,
        channel: createdGroup,
        channelLabel: `discussion group ${label}`,
        adminIdentifiers: auto.admins,
      },
      options,
    );
  }

  // Telegram sometimes needs a short delay before linkedChatId is visible.
  for (let i = 0; i < 8; i += 1) {
    const linked = await getLinkedDiscussionChatFilter(client, mirrorChannel);
    if (linked) {
      console.log(`discussion group linked: ${linked}`);
      await logSyncEvent({
        sourceChannelId,
        level: "info",
        message: `discussion group linked: ${linked}`,
      });
      return linked;
    }
    await sleep(400);
  }

  const groupId = toBigIntOrNull(createdGroup.id);
  const fallback = groupId && groupId > 0n ? `-100${groupId.toString()}` : null;
  console.log(`discussion group linked (unconfirmed): ${fallback ?? "(unknown)"}`);
  await logSyncEvent({
    sourceChannelId,
    level: "warn",
    message: `discussion group linked (unconfirmed): ${fallback ?? "(unknown)"}`,
  });
  return fallback;
}
