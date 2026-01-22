import dotenv from "dotenv";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { Api, TelegramClient } from "telegram";
import { generateRandomBigInt } from "telegram/Helpers";
import { StringSession } from "telegram/sessions";
import { getInputMedia } from "telegram/Utils";
import { sleep } from "./utils/sleep";

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function mediaHasSpoiler(media: unknown): boolean {
  if (!media || typeof media !== "object") return false;
  return (media as { spoiler?: unknown }).spoiler === true;
}

function buildInputMediaWithSpoiler(media: unknown): Api.TypeInputMedia | null {
  if (!mediaHasSpoiler(media)) return null;
  try {
    const input = getInputMedia(media as any) as any;
    if (input && typeof input === "object") (input as { spoiler?: boolean }).spoiler = true;
    return input as Api.TypeInputMedia;
  } catch {
    return null;
  }
}

async function ensureMirroredMessageSpoiler(
  client: TelegramClient,
  {
    targetEntity,
    targetMessageId,
    sourceMessage,
    mirroredMessage,
  }: {
    targetEntity: unknown;
    targetMessageId: number;
    sourceMessage: Api.Message;
    mirroredMessage?: Api.Message | null;
  },
): Promise<void> {
  const sourceMedia = sourceMessage.media;
  if (!sourceMedia || sourceMedia instanceof Api.MessageMediaWebPage) return;
  if (!mediaHasSpoiler(sourceMedia)) return;

  const mirrorMedia = mirroredMessage?.media;
  if (mirrorMedia && mediaHasSpoiler(mirrorMedia)) return;

  const inputMedia = buildInputMediaWithSpoiler(sourceMedia);
  if (!inputMedia) return;

  const peer = await client.getInputEntity(targetEntity as any);
  const rawText = typeof sourceMessage.message === "string" ? sourceMessage.message : "";
  const entities = Array.isArray(sourceMessage.entities) ? sourceMessage.entities : undefined;

  const editOnce = async () => {
    await client.invoke(
      new Api.messages.EditMessage({
        peer: peer as any,
        id: targetMessageId,
        media: inputMedia as any,
        message: rawText ? rawText : undefined,
        entities: rawText && entities ? (entities as any) : undefined,
      }),
    );
  };

  try {
    await editOnce();
  } catch (error: unknown) {
    const waitSeconds = parseFloodWaitSeconds(error);
    if (waitSeconds && waitSeconds <= 60) {
      await sleep(waitSeconds * 1000);
      await editOnce();
      return;
    }
    throw error;
  }
}

function normalizeChatIdentifier(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("+") || lower.startsWith("joinchat/")) {
    return trimmed;
  }

  // Accept common t.me forms: https://t.me/xxx, https://t.me/c/123/456, https://t.me/+hash
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  if (withoutProtocol.toLowerCase().startsWith("t.me/")) {
    const rest = withoutProtocol.slice("t.me/".length);
    const clean = rest.replace(/^\/+/, "");
    const cleanLower = clean.toLowerCase();

    if (cleanLower.startsWith("c/")) {
      const parts = clean.split(/[/?#]/)[0]?.split("/").filter(Boolean) ?? [];
      const chatId = parts[1] ?? "";
      if (/^\d+$/.test(chatId)) return `-100${chatId}`;
      return trimmed;
    }

    if (clean.startsWith("+") || cleanLower.startsWith("joinchat/")) {
      return trimmed;
    }

    const token = clean.split(/[/?#]/)[0] ?? "";
    if (!token) return trimmed;
    return token.startsWith("@") ? token : `@${token}`;
  }

  // If already @username or "me" or numeric id, keep as-is
  return trimmed;
}

function parseTelegramInviteHash(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const withoutDomain = withoutProtocol.toLowerCase().startsWith("t.me/")
    ? withoutProtocol.slice("t.me/".length)
    : withoutProtocol;

  const clean = withoutDomain.replace(/^\/+/, "");
  const cleanLower = clean.toLowerCase();

  let rest: string | null = null;
  if (clean.startsWith("+")) rest = clean.slice(1);
  else if (cleanLower.startsWith("joinchat/")) rest = clean.slice("joinchat/".length);
  if (rest == null) return null;

  const token = rest.split(/[/?#]/)[0]?.trim() ?? "";
  if (!token) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) return null;
  return token;
}

async function resolvePeer(client: TelegramClient, identifier: string): Promise<any> {
  const inviteHash = parseTelegramInviteHash(identifier);
  if (inviteHash) {
    const checked = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));

    if (checked instanceof Api.ChatInviteAlready) {
      const entity = (checked as any).chat;
      if (entity) return entity;
      throw new Error(`Failed to resolve invite (ChatInviteAlready missing chat): ${identifier}`);
    }

    if (checked instanceof Api.ChatInvite) {
      const imported = await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash }));
      const chats: unknown = (imported as any)?.chats;
      const entity = Array.isArray(chats) ? chats.find((c) => c instanceof Api.Channel || c instanceof Api.Chat) : null;
      if (entity) return entity;
      throw new Error(`Failed to import invite (no chat entity found): ${identifier}`);
    }

    throw new Error(`Unsupported invite response for ${identifier}`);
  }

  const normalized = normalizeChatIdentifier(identifier);
  return await client.getEntity(normalized);
}

type ParsedMessageLink = { sourceChat: string; messageId: number; canonicalLink: string };

function looksLikeMessageLink(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  return /t\.me\//i.test(trimmed) || /telegram\.me\//i.test(trimmed);
}

function parseMessageLink(raw: string): ParsedMessageLink {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty message link");

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const withoutDomain = withoutProtocol.replace(/^telegram\.me\//i, "t.me/").replace(/^t\.me\//i, "");
  const pathPart = withoutDomain.split(/[?#]/)[0] ?? "";
  const clean = pathPart.replace(/^\/+/, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`Invalid message link: ${raw}`);

  if ((parts[0] ?? "").toLowerCase() === "c") {
    if (parts.length < 3) throw new Error(`Invalid private message link: ${raw}`);
    const chatId = parts[1] ?? "";
    const msgIdRaw = parts[2] ?? "";
    const messageId = Number.parseInt(msgIdRaw, 10);
    if (!Number.isFinite(messageId) || messageId <= 0) throw new Error(`Invalid message id in link: ${raw}`);
    if (!/^\d+$/.test(chatId)) throw new Error(`Invalid chat id in link: ${raw}`);
    return { sourceChat: `-100${chatId}`, messageId, canonicalLink: `https://t.me/c/${chatId}/${messageId}` };
  }

  const usernameRaw = parts[0] ?? "";
  const messageId = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(messageId) || messageId <= 0) throw new Error(`Invalid message id in link: ${raw}`);

  const username = usernameRaw.replace(/^@/, "");
  if (!username) throw new Error(`Invalid username in link: ${raw}`);
  return { sourceChat: `@${username}`, messageId, canonicalLink: `https://t.me/${username}/${messageId}` };
}

function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value) {
    throw new Error(
      `Missing env ${name}. Copy \`.env.example\` -> \`.env\` and fill required values.`,
    );
  }
  return value;
}

function parseIntStrict(name: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function toIdString(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toString" in value) return String(value);
  return "unknown";
}

function getTelegramErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if (!("errorMessage" in error)) return undefined;
  const maybe = (error as { errorMessage?: unknown }).errorMessage;
  return typeof maybe === "string" ? maybe : undefined;
}

function parseFloodWaitSeconds(error: unknown): number | null {
  const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : "");
  const m = msg.match(/^FLOOD_WAIT_(\d+)$/);
  if (!m) return null;
  return Number.parseInt(m[1] ?? "", 10);
}

function collectNewMessagesFromUpdatesResult(result: unknown): Api.Message[] {
  const updates: unknown[] = [];
  if (result instanceof Api.UpdateShort) {
    updates.push(result.update);
  } else if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    updates.push(...result.updates);
  } else {
    return [];
  }

  const map = new Map<number, Api.Message>();
  for (const update of updates) {
    if (
      update instanceof Api.UpdateNewChannelMessage ||
      update instanceof Api.UpdateNewMessage ||
      update instanceof Api.UpdateNewScheduledMessage
    ) {
      const message = (update as any).message;
      if (message instanceof Api.Message && message.id) {
        map.set(message.id, message);
      }
    }
  }

  return [...map.values()].sort((a, b) => a.id - b.id);
}

function isRetryableCommentThreadError(error: unknown): boolean {
  const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : "");
  if (!msg) return false;
  return (
    msg.includes("MSG_ID_INVALID") ||
    msg.includes("MESSAGE_ID_INVALID") ||
    msg.includes("REPLY_MESSAGE_ID_INVALID") ||
    msg.includes("CHAT_ID_INVALID") ||
    msg.includes("CHANNEL_INVALID") ||
    msg.includes("PEER_ID_INVALID")
  );
}

async function withCommentSendRetry<T>(
  fn: () => Promise<T>,
  { label }: { label: string },
): Promise<T> {
  const delaysMs = [0, 250, 750, 1500, 2500];
  let lastError: unknown = null;

  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    const delay = delaysMs[attempt] ?? 0;
    if (delay > 0) await sleep(delay);

    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      const waitSeconds = parseFloodWaitSeconds(error);
      if (waitSeconds && waitSeconds <= 60) {
        await sleep(waitSeconds * 1000);
        continue;
      }
      if (isRetryableCommentThreadError(error) && attempt < delaysMs.length - 1) {
        continue;
      }
      const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
      throw new Error(`${label} failed: ${msg}`);
    }
  }

  const msg = lastError instanceof Error ? lastError.message : getTelegramErrorMessage(lastError) ?? String(lastError);
  throw new Error(`${label} failed: ${msg}`);
}

async function forwardMessagesAsCopy(
  client: TelegramClient,
  {
    fromPeer,
    toPeer,
    messageIds,
  }: {
    fromPeer: unknown;
    toPeer: unknown;
    messageIds: number[];
  },
): Promise<(Api.Message | undefined)[]> {
  const fromInput = await client.getInputEntity(fromPeer as any);
  const toInput = await client.getInputEntity(toPeer as any);

  const request = new Api.messages.ForwardMessages({
    fromPeer: fromInput as any,
    toPeer: toInput as any,
    id: messageIds,
    randomId: messageIds.map(() => generateRandomBigInt()),
    dropAuthor: true,
  });

  const result = await client.invoke(request);
  const recovered = collectNewMessagesFromUpdatesResult(result);
  if (recovered.length) {
    if (recovered.length !== messageIds.length) {
      console.warn(
        `ForwardMessages recovered ${recovered.length}/${messageIds.length} message(s) from updates; mapping may be approximate.`,
      );
    }
    const sliced = recovered.length > messageIds.length ? recovered.slice(recovered.length - messageIds.length) : recovered;
    return messageIds.map((_, idx) => sliced[idx]);
  }

  const parsed = client._getResponseMessage(request as any, result as any, toInput as any);
  if (Array.isArray(parsed)) return parsed.map((m) => (m instanceof Api.Message ? m : undefined));
  if (parsed instanceof Api.Message) return [parsed];
  return messageIds.map(() => undefined);
}

async function fetchMessage(client: TelegramClient, sourceEntity: unknown, messageId: number): Promise<Api.Message | null> {
  const msgs = await client.getMessages(sourceEntity as any, { ids: [messageId] });
  const msg = msgs?.[0];
  return msg instanceof Api.Message ? msg : null;
}

async function fetchAlbumMessages(client: TelegramClient, sourceEntity: unknown, anchor: Api.Message): Promise<Api.Message[]> {
  if (!anchor.groupedId) return [anchor];
  const groupKey = String(anchor.groupedId);
  const minId = Math.max(0, anchor.id - 120);
  const maxId = anchor.id + 120;

  const map = new Map<number, Api.Message>();
  map.set(anchor.id, anchor);

  for await (const m of client.iterMessages(sourceEntity as any, { reverse: true, minId, maxId, waitTime: 1 })) {
    if (!(m instanceof Api.Message)) continue;
    if (!m.id) continue;
    if (String(m.groupedId ?? "") !== groupKey) continue;
    map.set(m.id, m);
  }

  return [...map.values()].sort((a, b) => a.id - b.id);
}

function formatOriginalLinkComment(sourceLink: string): string {
  return `原文链接：${sourceLink}`;
}

function buildTargetMessageLink(targetEntity: unknown, messageId: number): string | null {
  if (targetEntity instanceof Api.Channel) {
    const username = typeof targetEntity.username === "string" ? targetEntity.username.trim().replace(/^@/, "") : "";
    if (username) return `https://t.me/${username}/${messageId}`;
    if (targetEntity.id) return `https://t.me/c/${targetEntity.id.toString()}/${messageId}`;
  }
  return null;
}

async function getLinkedDiscussionChatFilter(client: TelegramClient, channelEntity: unknown): Promise<string | null> {
  if (!(channelEntity instanceof Api.Channel)) return null;
  try {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: channelEntity }));
    const fullChat = (full as any)?.fullChat;
    if (fullChat instanceof Api.ChannelFull && fullChat.linkedChatId) {
      return `-100${fullChat.linkedChatId.toString()}`;
    }
  } catch {
    // ignore
  }
  return null;
}

async function syncCommentsForPost(
  client: TelegramClient,
  {
    sourceEntity,
    targetEntity,
    sourcePostId,
    targetPostId,
    targetPostIdCandidates,
    sourceLink,
    maxComments,
  }: {
    sourceEntity: unknown;
    targetEntity: unknown;
    sourcePostId: number;
    targetPostId: number;
    targetPostIdCandidates?: number[];
    sourceLink: string;
    maxComments: number;
  },
): Promise<void> {
  if (maxComments <= 0) return;

  const candidateIds = Array.from(
    new Set(
      [targetPostId, ...(Array.isArray(targetPostIdCandidates) ? targetPostIdCandidates : [])].filter(
        (id): id is number => Number.isFinite(id) && id > 0,
      ),
    ),
  );

  let postedLink = false;
  let commentToPostId = targetPostId;
  let processed = 0;
  let sent = 0;

  const ensureLinkComment = async () => {
    if (postedLink) return;
    for (const candidate of candidateIds) {
      try {
        await withCommentSendRetry(
          () =>
            client.sendMessage(targetEntity as any, {
              message: formatOriginalLinkComment(sourceLink),
              commentTo: candidate,
              linkPreview: false,
            }),
          { label: `post original link comment (commentTo=${candidate})` },
        );
        postedLink = true;
        commentToPostId = candidate;
        return;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        if (isRetryableCommentThreadError(error)) {
          console.warn(`comment thread not ready for commentTo=${candidate}: ${msg}`);
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Unable to post original link comment. Tried commentTo candidates: ${candidateIds.join(", ") || "(none)"}`,
    );
  };

  const sendSingle = async (m: Api.Message) => {
    const rawText = typeof m.message === "string" ? m.message : "";
    const formattingEntities = Array.isArray(m.entities) ? m.entities : undefined;
    if (!rawText.trim() && !m.media) return;

    await ensureLinkComment();

    if (m.media && !(m.media instanceof Api.MessageMediaWebPage)) {
      await withCommentSendRetry(
        () =>
          client.sendFile(targetEntity as any, {
            file: (buildInputMediaWithSpoiler(m.media) ?? m.media) as any,
            caption: rawText,
            formattingEntities,
            commentTo: commentToPostId,
          }),
        { label: `mirror comment media (id=${m.id})` },
      );
      sent += 1;
      return;
    }

    if (!rawText.trim()) return;
    await withCommentSendRetry(
      () =>
        client.sendMessage(targetEntity as any, {
          message: rawText,
          formattingEntities,
          commentTo: commentToPostId,
        }),
      { label: `mirror comment text (id=${m.id})` },
    );
    sent += 1;
  };

  let pendingAlbum: Api.Message[] = [];
  let pendingAlbumGroupId: string | null = null;

  const flushAlbum = async () => {
    if (!pendingAlbum.length) return;
    const groupId = pendingAlbumGroupId;
    const album = [...pendingAlbum].sort((a, b) => a.id - b.id);
    pendingAlbum = [];
    pendingAlbumGroupId = null;

    const canSendAsAlbum = album.every((m) => m.media && !(m.media instanceof Api.MessageMediaWebPage));
    if (!canSendAsAlbum) {
      for (const m of album) {
        try {
          await sendSingle(m);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
          console.error(`Failed to mirror comment id=${m.id}: ${msg}`);
        }
      }
      return;
    }

    const files = album.map((m) => (buildInputMediaWithSpoiler(m.media) ?? m.media) as any);
    const captions = album.map((m) => (typeof m.message === "string" ? m.message : ""));

    try {
      await ensureLinkComment();
      await withCommentSendRetry(
        () =>
          client.sendFile(targetEntity as any, {
            file: files,
            caption: captions,
            commentTo: commentToPostId,
          }),
        { label: `mirror comment album (groupedId=${groupId ?? "unknown"})` },
      );
      sent += album.length;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
      console.error(`Failed to mirror comment album groupedId=${groupId ?? "unknown"}: ${msg}`);
      for (const m of album) {
        try {
          await sendSingle(m);
        } catch (error2: unknown) {
          const msg2 = error2 instanceof Error ? error2.message : getTelegramErrorMessage(error2) ?? String(error2);
          console.error(`Failed to mirror comment id=${m.id}: ${msg2}`);
        }
      }
    }
  };

  console.log(`Syncing comments for ${sourceLink} (max=${maxComments})...`);
  await ensureLinkComment();
  for await (const m of client.iterMessages(sourceEntity as any, { replyTo: sourcePostId, reverse: true, waitTime: 1 })) {
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
      try {
        await sendSingle(m);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        console.error(`Failed to mirror comment id=${m.id}: ${msg}`);
      }
    }

    processed += 1;
    if (processed >= maxComments) break;
  }

  await flushAlbum();
  console.log(`Comments sync done for ${sourceLink}: sent=${sent}, processed=${processed}, commentTo=${commentToPostId}`);
}

async function readSessionFromFile(sessionFilePath: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf8");
    const trimmed = content.trim();
    return trimmed.length ? trimmed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeSessionToFile(sessionFilePath: string, session: string): Promise<void> {
  const trimmed = session.trim();
  if (!trimmed) return;
  await fs.writeFile(sessionFilePath, `${trimmed}\n`, { mode: 0o600 });
}

async function main(): Promise<void> {
  const packageRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(packageRoot, "../..");

  // Load root .env then local .env (local overrides root)
  dotenv.config({ path: path.join(repoRoot, ".env") });
  dotenv.config({ path: path.join(packageRoot, ".env"), override: true });

  const apiId = parseIntStrict("TELEGRAM_API_ID", requireEnv("TELEGRAM_API_ID"));
  const apiHash = requireEnv("TELEGRAM_API_HASH");

  const cliLinks = process.argv.slice(2).filter(looksLikeMessageLink);
  const envLinksRaw = getEnv("TG_POC_MESSAGE_LINKS") ?? getEnv("TG_POC_MESSAGE_LINK");
  const linksRaw = envLinksRaw
    ? envLinksRaw
        .split(/[,\n\r\t ]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : cliLinks;

  const parsedLinks = linksRaw.map(parseMessageLink);

  const sourceChat = parsedLinks.length ? "" : normalizeChatIdentifier(requireEnv("TG_POC_SOURCE_CHAT"));
  const targetChat = normalizeChatIdentifier(getEnv("TG_POC_TARGET_CHAT") ?? "me");
  const mode = (getEnv("TG_POC_MODE") ?? "forward").toLowerCase();
  const limit = parseIntStrict("TG_POC_LIMIT", getEnv("TG_POC_LIMIT") ?? "5");
  const syncCommentsEnabled = getEnv("TG_POC_SYNC_COMMENTS")?.toLowerCase() !== "false";
  const maxComments = parseIntStrict("TG_POC_MAX_COMMENTS", getEnv("TG_POC_MAX_COMMENTS") ?? "200");

  if (mode !== "forward" && mode !== "copy") {
    throw new Error(`Invalid TG_POC_MODE: ${mode} (expected: forward|copy)`);
  }
  if (limit <= 0 || limit > 50) {
    throw new Error(`Invalid TG_POC_LIMIT: ${limit} (expected: 1..50)`);
  }

  const sessionFilePath = path.join(packageRoot, ".telegram-session");
  const envSession = getEnv("TELEGRAM_SESSION");
  const fileSession = await readSessionFromFile(sessionFilePath);
  const sessionString = envSession ?? fileSession ?? "";

  console.log(
    [
      "PoC config:",
      parsedLinks.length ? `- source: message links (${parsedLinks.length})` : `- source: ${sourceChat}`,
      `- target: ${targetChat}${targetChat === "me" ? " (Saved Messages)" : ""}`,
      `- mode: ${mode}`,
      parsedLinks.length ? `- sync comments: ${syncCommentsEnabled ? "on" : "off"} (max=${maxComments})` : `- limit: ${limit}`,
      `- session: ${envSession ? "env" : fileSession ? "file" : "none (will login)"}`,
    ].join("\n"),
  );

  // Configure SOCKS5 proxy if available
  const proxyHost = process.env.PROXY_HOST || getEnv("WINDOWS_HOST");
  const proxyPort = process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT, 10) : 10808;

  const clientOptions: any = {
    connectionRetries: 5,
  };

  // Add SOCKS5 proxy configuration if proxy host is available
  if (proxyHost) {
    clientOptions.proxy = {
      socksType: 5,
      ip: proxyHost,
      port: proxyPort,
    };
    console.log(`Using SOCKS5 proxy: ${proxyHost}:${proxyPort}`);
  }

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, clientOptions);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const phoneFromEnv = getEnv("TELEGRAM_PHONE");
    const passwordFromEnv = getEnv("TELEGRAM_2FA_PASSWORD");

    await client.start({
      phoneNumber: async () => phoneFromEnv ?? (await rl.question("Telegram phone number: ")).trim(),
      password: async () =>
        passwordFromEnv ?? (await rl.question("Telegram 2FA password (if enabled): ")).trim(),
      phoneCode: async () => (await rl.question("Telegram login code: ")).trim(),
      onError: (err) => console.error("Telegram login error:", err),
    });

    const me = await client.getMe();
    console.log(
      `Logged in as ${(me as any)?.username ? `@${(me as any).username}` : (me as any)?.firstName ?? "unknown"} (id=${toIdString((me as any)?.id)})`,
    );

    const savedSession = client.session.save() as unknown as string;
    if (!envSession) {
      await writeSessionToFile(sessionFilePath, savedSession);
      console.log(`Saved session to ${sessionFilePath}`);
    }

    const targetEntity = await resolvePeer(client, targetChat);
    const targetIsChannel = targetEntity instanceof Api.Channel && !!(targetEntity as any).broadcast;
    const targetHasDiscussion = syncCommentsEnabled && targetIsChannel ? await getLinkedDiscussionChatFilter(client, targetEntity) : null;
    if (syncCommentsEnabled) {
      if (!targetIsChannel) {
        console.warn(
          `Comment sync may not work: TG_POC_TARGET_CHAT=${targetChat} is not a channel (it might be a group/user). Use a channel and link a discussion group.`,
        );
      } else if (!targetHasDiscussion) {
        console.warn(
          `Comment sync is enabled but target channel has no linked discussion group. Telegram cannot create a comment thread, so comments will be skipped.`,
        );
      }
    }

    if (parsedLinks.length) {
      console.log(`Mirroring ${parsedLinks.length} message link(s) to ${targetChat} (mode=${mode})...`);

      for (const link of parsedLinks) {
        try {
          const sourceEntity = await resolvePeer(client, link.sourceChat);
          const msg = await fetchMessage(client, sourceEntity, link.messageId);
          if (!msg) {
            console.error(`Message not found: ${link.canonicalLink}`);
            continue;
          }

          const album = await fetchAlbumMessages(client, sourceEntity, msg);
          const messageIds = album.map((m) => m.id);

          if (mode === "forward") {
            const forwarded = await forwardMessagesAsCopy(client, { fromPeer: sourceEntity, toPeer: targetEntity, messageIds });
            for (let i = 0; i < album.length; i += 1) {
              const mirrorMessageId = forwarded[i]?.id ?? null;
              if (!mirrorMessageId) continue;
              try {
                await ensureMirroredMessageSpoiler(client, {
                  targetEntity,
                  targetMessageId: mirrorMessageId,
                  sourceMessage: album[i]!,
                  mirroredMessage: forwarded[i] ?? null,
                });
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : getTelegramErrorMessage(e) ?? String(e);
                console.warn(`Failed to apply spoiler for mirrored message id=${mirrorMessageId}: ${msg}`);
              }
            }
            const mirroredIds = forwarded.map((m) => m?.id).filter((id): id is number => typeof id === "number" && id > 0);
            const mirroredLinks = mirroredIds
              .map((id) => buildTargetMessageLink(targetEntity, id))
              .filter((l): l is string => typeof l === "string" && l.length > 0);

            console.log(
              `Forwarded ${messageIds.length} message(s): ${link.canonicalLink} -> ids=${mirroredIds.join(",")}${
                mirroredLinks.length ? ` (open: ${mirroredLinks[0]})` : ""
              }`,
            );

            if (syncCommentsEnabled && targetHasDiscussion && msg.post && forwarded.length) {
              const idx = messageIds.indexOf(msg.id);
              const mirrorPostId = forwarded[idx >= 0 ? idx : 0]?.id;
              if (mirrorPostId) {
                try {
                  await syncCommentsForPost(client, {
                    sourceEntity,
                    targetEntity,
                    sourcePostId: msg.id,
                    targetPostId: mirrorPostId,
                    targetPostIdCandidates: mirroredIds,
                    sourceLink: link.canonicalLink,
                    maxComments,
                  });
                  console.log(`Synced comments for post id=${msg.id}`);
                } catch (e: unknown) {
                  const m1 = e instanceof Error ? e.message : getTelegramErrorMessage(e) ?? String(e);
                  console.warn(`Sync comments failed for ${link.canonicalLink}: ${m1}`);
                }
              }
            }
            continue;
          }

          const text = (msg.message ?? "").trim();
          if (!text) {
            console.log(`Skipped message id=${msg.id} (no text in copy mode)`);
            continue;
          }
          await client.sendMessage(targetEntity, { message: text });
          console.log(`Copied message id=${msg.id}`);
        } catch (error) {
          console.error(`Failed to mirror ${link.canonicalLink}:`, error);
        }
      }
    } else {
      const sourceEntity = await resolvePeer(client, sourceChat);
      const messages = await client.getMessages(sourceEntity, { limit });
      const ordered = [...messages].reverse();

      console.log(`Fetched ${messages.length} messages from ${sourceChat}. Mirroring to ${targetChat} (mode=${mode})...`);
      if (messages.length === 0) {
        console.log(
          "No messages fetched. Check that the source identifier is correct and that your account can access this chat/channel.",
        );
      }

      for (const msg of ordered) {
        try {
          if (mode === "forward") {
            const forwarded = await forwardMessagesAsCopy(client, { fromPeer: sourceEntity, toPeer: targetEntity, messageIds: [msg.id] });
            const mirrorMessageId = forwarded[0]?.id ?? null;
            if (mirrorMessageId) {
              try {
                await ensureMirroredMessageSpoiler(client, {
                  targetEntity,
                  targetMessageId: mirrorMessageId,
                  sourceMessage: msg,
                  mirroredMessage: forwarded[0] ?? null,
                });
              } catch (e: unknown) {
                const m1 = e instanceof Error ? e.message : getTelegramErrorMessage(e) ?? String(e);
                console.warn(`Failed to apply spoiler for mirrored message id=${mirrorMessageId}: ${m1}`);
              }
            }
            console.log(`Forwarded message id=${msg.id}`);
            continue;
          }

          const text = (msg.message ?? "").trim();
          if (!text) {
            console.log(`Skipped message id=${msg.id} (no text in copy mode)`);
            continue;
          }
          await client.sendMessage(targetEntity, { message: text });
          console.log(`Copied message id=${msg.id}`);
        } catch (error) {
          console.error(`Failed to mirror message id=${msg.id}:`, error);
        }
      }
    }

    console.log("PoC done.");
  } finally {
    rl.close();
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
