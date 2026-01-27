import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { db, schema, sqlClient } from "@tg-back/db";
import { Api, TelegramClient } from "telegram";
import { NewMessage, Raw } from "telegram/events";
import { generateRandomBigInt, returnBigInt } from "telegram/Helpers";
import { StringSession } from "telegram/sessions";
import { getInputMedia } from "telegram/Utils";
import { decrypt } from "./utils/crypto";
import { loadEnv } from "./utils/env";
import { setupFileLogging } from "./utils/file-logging";
import { sleep } from "./utils/sleep";

loadEnv();
const fileLogging = setupFileLogging();
if (fileLogging) {
  console.log(`file logging enabled: ${fileLogging.filePath}`);
}

const originalLinkCommentKeys = new Set<string>();
const autoChannelAdminKeys = new Set<string>();
const MIRROR_SERVICE_HEARTBEAT_KEY = "mirror_service_heartbeat";
const MIRROR_SERVICE_HEARTBEAT_INTERVAL_MS = 30_000;
const TASKS_NOTIFY_CHANNEL = "tg_back_sync_tasks_v1";
const FLOOD_WAIT_AUTO_SLEEP_MAX_SEC = (() => {
  const raw = Number.parseInt(process.env.MIRROR_FLOOD_WAIT_MAX_SEC ?? "600", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 600;
  return Math.min(raw, 3600);
})();

type SyncEventLevel = (typeof schema.eventLevelEnum.enumValues)[number];

const MAX_EVENT_MESSAGE_LEN = 2_000;

let lastNotifyErrorAt = 0;
async function notifyTasksChanged(payload: {
  taskId?: string;
  sourceChannelId?: string;
  taskType?: string;
  status?: string;
}): Promise<void> {
  try {
    await sqlClient.notify(
      TASKS_NOTIFY_CHANNEL,
      JSON.stringify({
        ts: new Date().toISOString(),
        ...payload,
      }),
    );
  } catch (error: unknown) {
    const now = Date.now();
    if (now - lastNotifyErrorAt < 10_000) return;
    lastNotifyErrorAt = now;
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to notify tasks change: ${msg}`);
  }
}

function trimAndTruncateEventMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "(empty)";
  if (trimmed.length <= MAX_EVENT_MESSAGE_LEN) return trimmed;
  return `${trimmed.slice(0, MAX_EVENT_MESSAGE_LEN - 1)}…`;
}

async function logSyncEvent(args: { sourceChannelId: string | null; level: SyncEventLevel; message: string }): Promise<void> {
  try {
    await db.insert(schema.syncEvents).values({
      sourceChannelId: args.sourceChannelId,
      level: args.level,
      message: trimAndTruncateEventMessage(args.message),
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to log sync event: ${msg}`);
  }
}

function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 0 ? false : value === 1 ? true : null;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return null;
}

type RuntimeSettings = {
  syncMessageEdits: boolean;
  keepEditHistory: boolean;
  syncMessageDeletions: boolean;
};

const SETTINGS_CACHE_MS = 5_000;
let cachedRuntimeSettings: RuntimeSettings | null = null;
let cachedRuntimeSettingsAt = 0;

async function getRuntimeSettings(): Promise<RuntimeSettings> {
  const now = Date.now();
  if (cachedRuntimeSettings && now - cachedRuntimeSettingsAt < SETTINGS_CACHE_MS) return cachedRuntimeSettings;

  const keys = ["sync_message_edits", "keep_edit_history", "sync_message_deletions"] as const;

  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(inArray(schema.settings.key, keys as unknown as string[]));

  const map = new Map(rows.map((r) => [r.key, r.value]));

  const syncMessageEdits =
    toBooleanOrNull(map.get("sync_message_edits")) ?? (schema.defaultSettings.sync_message_edits === true);
  const keepEditHistory = toBooleanOrNull(map.get("keep_edit_history")) ?? (schema.defaultSettings.keep_edit_history === true);
  const syncMessageDeletions =
    toBooleanOrNull(map.get("sync_message_deletions")) ?? (schema.defaultSettings.sync_message_deletions === true);

  cachedRuntimeSettings = { syncMessageEdits, keepEditHistory, syncMessageDeletions };
  cachedRuntimeSettingsAt = now;
  return cachedRuntimeSettings;
}

type MirrorBehaviorSettings = {
  mirrorIntervalMs: number;
  mirrorVideos: boolean;
  maxFileSizeMb: number;
  maxFileSizeBytes: number | null;
  skipProtectedContent: boolean;
  groupMediaMessages: boolean;
};

const MIRROR_BEHAVIOR_SETTINGS_CACHE_MS = 5_000;
let cachedMirrorBehaviorSettings: MirrorBehaviorSettings | null = null;
let cachedMirrorBehaviorSettingsAt = 0;

async function getMirrorBehaviorSettings(): Promise<MirrorBehaviorSettings> {
  const now = Date.now();
  if (cachedMirrorBehaviorSettings && now - cachedMirrorBehaviorSettingsAt < MIRROR_BEHAVIOR_SETTINGS_CACHE_MS) {
    return cachedMirrorBehaviorSettings;
  }

  const keys = [
    "mirror_interval_ms",
    "mirror_videos",
    "max_file_size_mb",
    "skip_protected_content",
    "group_media_messages",
  ] as const;

  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(inArray(schema.settings.key, keys as unknown as string[]));

  const map = new Map(rows.map((r) => [r.key, r.value]));

  const mirrorIntervalMsRaw = toNumberOrNull(map.get("mirror_interval_ms")) ?? schema.defaultSettings.mirror_interval_ms;
  const mirrorIntervalMs = Math.min(10_000, Math.max(0, Math.floor(mirrorIntervalMsRaw)));

  const mirrorVideos = toBooleanOrNull(map.get("mirror_videos")) ?? (schema.defaultSettings.mirror_videos === true);

  const maxFileSizeMbRaw = toNumberOrNull(map.get("max_file_size_mb")) ?? schema.defaultSettings.max_file_size_mb;
  const maxFileSizeMb = Math.min(10_000, Math.max(0, Math.floor(maxFileSizeMbRaw)));
  const maxFileSizeBytes = maxFileSizeMb > 0 ? maxFileSizeMb * 1024 * 1024 : null;

  const skipProtectedContent =
    toBooleanOrNull(map.get("skip_protected_content")) ?? (schema.defaultSettings.skip_protected_content === true);

  const groupMediaMessages =
    toBooleanOrNull(map.get("group_media_messages")) ?? (schema.defaultSettings.group_media_messages === true);

  cachedMirrorBehaviorSettings = {
    mirrorIntervalMs,
    mirrorVideos,
    maxFileSizeMb,
    maxFileSizeBytes,
    skipProtectedContent,
    groupMediaMessages,
  };
  cachedMirrorBehaviorSettingsAt = now;
  return cachedMirrorBehaviorSettings;
}

type MessageFilterSettings = {
  enabled: boolean;
  keywords: string[];
};

const MESSAGE_FILTER_SETTINGS_CACHE_MS = 5_000;
let cachedMessageFilterSettings: MessageFilterSettings | null = null;
let cachedMessageFilterSettingsAt = 0;

function parseMessageFilterKeywords(raw: string): string[] {
  const parts = raw
    .split(/[\n\r,，\s]+/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const keyword = p.slice(0, 100).toLowerCase();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push(keyword);
    if (out.length >= 200) break;
  }
  return out;
}

async function getMessageFilterSettings(): Promise<MessageFilterSettings> {
  const now = Date.now();
  if (cachedMessageFilterSettings && now - cachedMessageFilterSettingsAt < MESSAGE_FILTER_SETTINGS_CACHE_MS) {
    return cachedMessageFilterSettings;
  }

  const keys = ["message_filter_enabled", "message_filter_keywords"] as const;

  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(inArray(schema.settings.key, keys as unknown as string[]));

  const map = new Map(rows.map((r) => [r.key, r.value]));

  const enabled =
    toBooleanOrNull(map.get("message_filter_enabled")) ?? (schema.defaultSettings.message_filter_enabled === true);

  const keywordsRawValue = map.get("message_filter_keywords");
  const keywordsRaw =
    typeof keywordsRawValue === "string" ? keywordsRawValue : keywordsRawValue == null ? "" : String(keywordsRawValue);

  const keywords = enabled ? parseMessageFilterKeywords(keywordsRaw) : [];

  cachedMessageFilterSettings = { enabled: !!enabled, keywords };
  cachedMessageFilterSettingsAt = now;
  return cachedMessageFilterSettings;
}

const CHANNEL_MESSAGE_FILTER_SETTINGS_CACHE_MS = 5_000;
const cachedChannelMessageFilterSettings = new Map<
  string,
  { at: number; mode: (typeof schema.messageFilterModeEnum.enumValues)[number]; keywords: string }
>();

async function getChannelMessageFilterSettings(sourceChannelId: string): Promise<{
  mode: (typeof schema.messageFilterModeEnum.enumValues)[number];
  keywords: string;
}> {
  const now = Date.now();
  const cached = cachedChannelMessageFilterSettings.get(sourceChannelId);
  if (cached && now - cached.at < CHANNEL_MESSAGE_FILTER_SETTINGS_CACHE_MS) {
    return { mode: cached.mode, keywords: cached.keywords };
  }

  try {
    const [row] = await db
      .select({
        mode: schema.sourceChannels.messageFilterMode,
        keywords: schema.sourceChannels.messageFilterKeywords,
      })
      .from(schema.sourceChannels)
      .where(eq(schema.sourceChannels.id, sourceChannelId))
      .limit(1);

    const mode = row?.mode ?? "inherit";
    const keywords = row?.keywords ?? "";
    const normalizedMode = mode === "disabled" || mode === "custom" ? mode : "inherit";

    cachedChannelMessageFilterSettings.set(sourceChannelId, { at: now, mode: normalizedMode, keywords });
    return { mode: normalizedMode, keywords };
  } catch {
    cachedChannelMessageFilterSettings.set(sourceChannelId, { at: now, mode: "inherit", keywords: "" });
    return { mode: "inherit", keywords: "" };
  }
}

async function getEffectiveMessageFilterSettings(sourceChannelId: string): Promise<MessageFilterSettings> {
  const channelSettings = await getChannelMessageFilterSettings(sourceChannelId);
  if (channelSettings.mode === "disabled") return { enabled: false, keywords: [] };
  if (channelSettings.mode === "custom") {
    return { enabled: true, keywords: parseMessageFilterKeywords(channelSettings.keywords) };
  }
  return await getMessageFilterSettings();
}

function shouldSkipMessageByFilter(text: string, filter: MessageFilterSettings): boolean {
  if (!filter.enabled || !filter.keywords.length) return false;
  const content = text.trim();
  if (!content) return false;
  const haystack = content.toLowerCase();
  for (const keyword of filter.keywords) {
    if (haystack.includes(keyword)) return true;
  }
  return false;
}

async function throttleMirrorSend(intervalMs: number): Promise<void> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  await sleep(intervalMs);
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  }
  return null;
}

type TaskRunnerSettings = {
  concurrentMirrors: number;
};

const TASK_RUNNER_SETTINGS_CACHE_MS = 5_000;
let cachedTaskRunnerSettings: TaskRunnerSettings | null = null;
let cachedTaskRunnerSettingsAt = 0;

async function getTaskRunnerSettings(): Promise<TaskRunnerSettings> {
  const now = Date.now();
  if (cachedTaskRunnerSettings && now - cachedTaskRunnerSettingsAt < TASK_RUNNER_SETTINGS_CACHE_MS) {
    return cachedTaskRunnerSettings;
  }

  const keys = ["concurrent_mirrors"] as const;
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(inArray(schema.settings.key, keys as unknown as string[]));

  const map = new Map(rows.map((r) => [r.key, r.value]));

  const concurrentMirrorsRaw = toNumberOrNull(map.get("concurrent_mirrors")) ?? schema.defaultSettings.concurrent_mirrors;
  const concurrentMirrors = Math.min(10, Math.max(1, Math.floor(concurrentMirrorsRaw)));

  cachedTaskRunnerSettings = { concurrentMirrors };
  cachedTaskRunnerSettingsAt = now;
  return cachedTaskRunnerSettings;
}

type RetryBehaviorSettings = {
  maxRetryCount: number;
  retryIntervalSec: number;
  skipAfterMaxRetry: boolean;
};

const RETRY_BEHAVIOR_SETTINGS_CACHE_MS = 5_000;
let cachedRetryBehaviorSettings: RetryBehaviorSettings | null = null;
let cachedRetryBehaviorSettingsAt = 0;

async function getRetryBehaviorSettings(): Promise<RetryBehaviorSettings> {
  const now = Date.now();
  if (cachedRetryBehaviorSettings && now - cachedRetryBehaviorSettingsAt < RETRY_BEHAVIOR_SETTINGS_CACHE_MS) {
    return cachedRetryBehaviorSettings;
  }

  const keys = ["max_retry_count", "retry_interval_sec", "skip_after_max_retry"] as const;

  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(inArray(schema.settings.key, keys as unknown as string[]));

  const map = new Map(rows.map((r) => [r.key, r.value]));

  const maxRetryCountRaw = toNumberOrNull(map.get("max_retry_count")) ?? schema.defaultSettings.max_retry_count;
  const maxRetryCount = Math.min(100, Math.max(0, Math.floor(maxRetryCountRaw)));

  const retryIntervalSecRaw = toNumberOrNull(map.get("retry_interval_sec")) ?? schema.defaultSettings.retry_interval_sec;
  const retryIntervalSec = Math.min(86_400, Math.max(0, Math.floor(retryIntervalSecRaw)));

  const skipAfterMaxRetry =
    toBooleanOrNull(map.get("skip_after_max_retry")) ?? (schema.defaultSettings.skip_after_max_retry === true);

  cachedRetryBehaviorSettings = { maxRetryCount, retryIntervalSec, skipAfterMaxRetry };
  cachedRetryBehaviorSettingsAt = now;
  return cachedRetryBehaviorSettings;
}

function toTrimmedStringOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value == null) return null;
  const str = String(value).trim();
  return str ? str : null;
}

type AutoChannelSettings = {
  prefix: string;
  privateChannel: boolean;
  admins: string[];
};

function normalizeUserIdentifier(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("+") || lower.startsWith("joinchat/")) return trimmed;

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  if (withoutProtocol.toLowerCase().startsWith("t.me/")) {
    const rest = withoutProtocol.slice("t.me/".length);
    const clean = rest.replace(/^\/+/, "");
    const cleanLower = clean.toLowerCase();
    if (clean.startsWith("+") || cleanLower.startsWith("joinchat/")) return trimmed;
    const token = clean.split(/[/?#]/)[0] ?? "";
    if (!token) return trimmed;
    return token.startsWith("@") ? token : `@${token}`;
  }

  if (trimmed.startsWith("@")) return trimmed;
  if (/^\d+$/.test(trimmed)) return trimmed;
  return `@${trimmed}`;
}

function parseUserIdentifierList(input: string | null): string[] {
  const raw = (input ?? "").trim();
  if (!raw) return [];
  const tokens = raw
    .split(/[\s,，;；]+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => normalizeUserIdentifier(t))
    .filter(Boolean);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

async function getAutoChannelSettings(): Promise<AutoChannelSettings> {
  const keys = ["auto_channel_prefix", "auto_channel_private", "auto_channel_admins"] as const;

  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings)
    .where(inArray(schema.settings.key, keys as unknown as string[]));

  const map = new Map(rows.map((r) => [r.key, r.value]));

  const prefix = toTrimmedStringOrNull(map.get("auto_channel_prefix")) ?? schema.defaultSettings.auto_channel_prefix;
  const privateChannel =
    toBooleanOrNull(map.get("auto_channel_private")) ?? (schema.defaultSettings.auto_channel_private === true);

  const adminsRaw = toTrimmedStringOrNull(map.get("auto_channel_admins")) ?? schema.defaultSettings.auto_channel_admins;
  const admins = parseUserIdentifierList(adminsRaw);

  return { prefix, privateChannel, admins };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function normalizeChatIdentifier(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("+") || lower.startsWith("joinchat/")) {
    return trimmed;
  }

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

function buildCanonicalChannelIdentifier(
  resolved: { peerType: string; telegramId: bigint | null; username: string | null },
  fallback: string,
): string {
  const fallbackTrimmed = fallback.trim();

  if (resolved.peerType === "channel") {
    const username = typeof resolved.username === "string" ? resolved.username.trim().replace(/^@/, "") : "";
    if (username) return `@${username}`;
    if (typeof resolved.telegramId === "bigint" && resolved.telegramId > 0n) return `-100${resolved.telegramId.toString()}`;
    return fallbackTrimmed;
  }

  if (resolved.peerType === "user") {
    if (fallbackTrimmed.toLowerCase() === "me") return "me";
    const username = typeof resolved.username === "string" ? resolved.username.trim().replace(/^@/, "") : "";
    if (username) return `@${username}`;
    return fallbackTrimmed;
  }

  return fallbackTrimmed;
}

function buildSourceMessageLink(
  source: { username?: string | null; telegramId?: bigint | null },
  messageId: number,
): string | null {
  const username = typeof source.username === "string" ? source.username.trim().replace(/^@/, "") : "";
  if (username) return `https://t.me/${username}/${messageId}`;
  const telegramId = source.telegramId;
  if (typeof telegramId === "bigint" && telegramId > 0n) return `https://t.me/c/${telegramId.toString()}/${messageId}`;
  return null;
}

function formatOriginalLinkComment(sourceLink: string): string {
  return `原文链接：${sourceLink}`;
}

function toBigIntOrNull(value: unknown): bigint | null {
  if (value == null) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isFinite(value) ? BigInt(value) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  if (typeof value === "object" && value && "toString" in value) {
    const str = String((value as { toString: () => string }).toString()).trim();
    if (!str || str === "[object Object]") return null;
    if (!/^-?\d+$/.test(str)) return null;
    try {
      return BigInt(str);
    } catch {
      return null;
    }
  }
  return null;
}

function getTelegramErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if (!("errorMessage" in error)) return undefined;
  const maybe = (error as { errorMessage?: unknown }).errorMessage;
  return typeof maybe === "string" ? maybe : undefined;
}

function parseFloodWaitSeconds(error: unknown): number | null {
  const msg =
    typeof error === "string" ? error : getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : "");
  if (!msg) return null;
  const m1 = msg.match(/FLOOD_WAIT_(\d+)/);
  if (m1) return Number.parseInt(m1[1] ?? "", 10);
  const m2 = msg.match(/A wait of (\d+) seconds is required/i);
  if (m2) return Number.parseInt(m2[1] ?? "", 10);
  return null;
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

function collectMessageIdsByRandomIdFromUpdatesResult(result: unknown): Map<string, number> {
  const updates: unknown[] = [];
  if (result instanceof Api.UpdateShort) {
    updates.push(result.update);
  } else if (result instanceof Api.Updates || result instanceof Api.UpdatesCombined) {
    updates.push(...result.updates);
  } else {
    return new Map();
  }

  const map = new Map<string, number>();
  for (const update of updates) {
    if (!(update instanceof Api.UpdateMessageID)) continue;
    const randomId = toBigIntOrNull((update as any).randomId);
    if (!randomId) continue;
    if (!update.id) continue;
    map.set(randomId.toString(), update.id);
  }

  return map;
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

function getSendFileMediaForMessage(message: Api.Message): unknown {
  const media = message.media;
  if (!media || media instanceof Api.MessageMediaWebPage) return null;
  return buildInputMediaWithSpoiler(media) ?? media;
}

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
  const sourceMedia = sourceMessage.media;
  if (!sourceMedia || sourceMedia instanceof Api.MessageMediaWebPage) return;
  if (!mediaHasSpoiler(sourceMedia)) return;

  const mirrorMedia = mirroredMessage?.media;
  if (mirrorMedia && mediaHasSpoiler(mirrorMedia)) return;

  const inputMedia = buildInputMediaWithSpoiler(sourceMedia);
  if (!inputMedia) return;

  const rawText = typeof sourceMessage.message === "string" ? sourceMessage.message : "";
  const entities = Array.isArray(sourceMessage.entities) ? sourceMessage.entities : undefined;
  const mirrorPeerInput = await client.getInputEntity(mirrorPeer as any);

  const editOnce = async () => {
    await client.invoke(
      new Api.messages.EditMessage({
        peer: mirrorPeerInput as any,
        id: mirrorMessageId,
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
    if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
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
  if (!sourceLink) return;

  const key = `${mirrorChannelId}:${mirrorPostId}`;
  if (originalLinkCommentKeys.has(key)) return;
  if (originalLinkCommentKeys.size > 10_000) originalLinkCommentKeys.clear();

  const sendOnce = async () => {
    await client.sendMessage(mirrorEntity as any, {
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
      if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
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

function messageTypeFromMessage(message: Api.Message): (typeof schema.messageTypeEnum.enumValues)[number] {
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

function extractMediaFileSize(message: Api.Message): number | null {
  const media = message.media;
  if (!media) return null;
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document as unknown;
    const size = doc && typeof doc === "object" && "size" in doc ? (doc as any).size : undefined;
    if (typeof size === "number" && Number.isFinite(size) && size >= 0) return Math.floor(size);
    if (typeof size === "bigint") return Number(size);
  }
  if (media instanceof Api.MessageMediaPhoto) {
    const photo = (media as any).photo;
    const sizes: unknown = photo && typeof photo === "object" ? (photo as any).sizes : null;
    if (!Array.isArray(sizes)) return null;
    let max = 0;
    for (const s of sizes) {
      if (!s || typeof s !== "object") continue;
      const value = (s as any).size ?? (s as any).bytes;
      if (typeof value === "number" && Number.isFinite(value) && value > max) max = value;
    }
    return max > 0 ? max : null;
  }
  return null;
}

function classifyMirrorError(error: unknown): { skipReason?: (typeof schema.skipReasonEnum.enumValues)[number] } {
  const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
  if (msg.includes("FORWARDS_RESTRICTED") || msg.includes("CHAT_FORWARDS_RESTRICTED")) {
    return { skipReason: "protected_content" };
  }
  if (msg.includes("MESSAGE_ID_INVALID") || msg.includes("MESSAGE_NOT_FOUND")) {
    return { skipReason: "message_deleted" };
  }
  return {};
}

function getDbErrorMeta(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const maybe = error as Record<string, unknown>;
  const parts: string[] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) parts.push(`${label}=${value}`);
  };
  add("code", maybe.code);
  add("severity", maybe.severity);
  add("constraint", maybe.constraint);
  add("detail", maybe.detail);
  add("table", maybe.table);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function getDbErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const maybe = error as Record<string, unknown>;
  if (typeof maybe.code === "string" && maybe.code.trim()) return maybe.code.trim();
  if ("cause" in maybe) return getDbErrorCode(maybe.cause);
  return null;
}

function isDbConnectionError(error: unknown): boolean {
  const code = getDbErrorCode(error);
  if (code) {
    const normalized = code.toUpperCase();
    if (normalized === "CONNECTION_CLOSED") return true;
    if (normalized === "ECONNRESET") return true;
    if (normalized === "ETIMEDOUT") return true;
    if (normalized === "EPIPE") return true;
    if (normalized === "ECONNREFUSED") return true;
  }

  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("CONNECTION_CLOSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("EPIPE") ||
    msg.includes("ECONNREFUSED")
  );
}

async function withDbRetry<T>(
  operation: () => Promise<T>,
  context: string,
  options?: { attempts?: number; baseDelayMs?: number },
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options?.attempts ?? 3));
  const baseDelayMs = Math.max(50, Math.floor(options?.baseDelayMs ?? 250));

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      if (!isDbConnectionError(error) || attempt === attempts) throw error;
      const delay = Math.min(5_000, baseDelayMs * attempt * attempt);
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`db connection error, retrying (${context}) in ${delay}ms: ${msg}`);
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(obj) as Array<[keyof T, T[keyof T]]>) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function writeMirrorServiceHeartbeat(startedAt: Date): Promise<void> {
  const value = {
    lastHeartbeatAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    pid: process.pid,
  };

  try {
    await withDbRetry(
      () =>
        db
          .insert(schema.settings)
          .values({ key: MIRROR_SERVICE_HEARTBEAT_KEY, value })
          .onConflictDoUpdate({ target: schema.settings.key, set: { value } }),
      "mirror-service heartbeat",
      { attempts: 1, baseDelayMs: 250 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to write mirror-service heartbeat: ${msg}`);
  }
}

type MessageMappingUpdate = Partial<typeof schema.messageMappings.$inferInsert>;

async function updateMessageMappingsByIds(mappingIds: string[], set: MessageMappingUpdate, context: string): Promise<void> {
  if (!mappingIds.length) return;

  const cleanSet = omitUndefined(set);
  if (!Object.keys(cleanSet).length) throw new Error(`updateMessageMappingsByIds called with empty set (${context})`);

  try {
    await withDbRetry(
      () => db.update(schema.messageMappings).set(cleanSet).where(inArray(schema.messageMappings.id, mappingIds)),
      `bulk update message_mappings (${context}, n=${mappingIds.length})`,
      { attempts: 3, baseDelayMs: 250 },
    );
    return;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(
      `bulk update message_mappings failed (${context}, n=${mappingIds.length})${getDbErrorMeta(error)}: ${msg}`,
    );
  }

  let failures = 0;
  for (const id of mappingIds) {
    try {
      await withDbRetry(
        () => db.update(schema.messageMappings).set(cleanSet).where(eq(schema.messageMappings.id, id)),
        `single update message_mappings (${context}, id=${id})`,
        { attempts: 3, baseDelayMs: 250 },
      );
    } catch (error: unknown) {
      failures += 1;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`update message_mappings failed (${context}, id=${id})${getDbErrorMeta(error)}: ${msg}`);
    }
  }

  if (failures) {
    throw new Error(`failed to update message_mappings for ${failures}/${mappingIds.length} rows (${context})`);
  }
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

type SourceChannelMetadata = {
  description?: string | null;
  memberCount?: number | null;
  isProtected?: boolean;
};

async function getSourceChannelMetadata(client: TelegramClient, channelEntity: unknown): Promise<SourceChannelMetadata> {
  if (!(channelEntity instanceof Api.Channel)) return {};

  const out: SourceChannelMetadata = {};

  if (typeof (channelEntity as any).noforwards === "boolean") {
    out.isProtected = (channelEntity as any).noforwards;
  }

  try {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: channelEntity }));
    const fullChat = (full as any)?.fullChat;
    if (fullChat instanceof Api.ChannelFull) {
      if (typeof (fullChat as any).about === "string") {
        const about = (fullChat as any).about.trim();
        out.description = about ? about : null;
      }
      if (typeof (fullChat as any).participantsCount === "number" && Number.isFinite((fullChat as any).participantsCount)) {
        out.memberCount = Math.max(0, Math.floor((fullChat as any).participantsCount));
      }
    }
  } catch {
    // ignore
  }

  return out;
}

type ChannelHealthCheckSettings = {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  refreshMs: number;
};

function getChannelHealthCheckSettings(): ChannelHealthCheckSettings {
  const enabled = process.env.MIRROR_CHANNEL_HEALTHCHECK?.trim() !== "false";

  const intervalSecRaw = Number.parseInt(process.env.MIRROR_CHANNEL_HEALTHCHECK_INTERVAL_SEC ?? "60", 10);
  const intervalSec = Number.isFinite(intervalSecRaw) && intervalSecRaw > 0 ? Math.min(intervalSecRaw, 86_400) : 60;

  const batchRaw = Number.parseInt(process.env.MIRROR_CHANNEL_HEALTHCHECK_BATCH ?? "1", 10);
  const batchSize = Number.isFinite(batchRaw) && batchRaw > 0 ? Math.min(batchRaw, 20) : 1;

  const refreshSecRaw = Number.parseInt(process.env.MIRROR_CHANNEL_HEALTHCHECK_REFRESH_SEC ?? "300", 10);
  const refreshSec = Number.isFinite(refreshSecRaw) && refreshSecRaw > 0 ? Math.min(refreshSecRaw, 86_400) : 300;

  return {
    enabled,
    intervalMs: intervalSec * 1000,
    batchSize,
    refreshMs: refreshSec * 1000,
  };
}

type HealthCheckChannelRow = {
  id: string;
  channelIdentifier: string;
  telegramId: bigint;
  accessHash: bigint;
};

function isChannelInaccessibleError(error: unknown): boolean {
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

function extractSourceChannelMetadataFromChatFull(
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

  const fullChat = (result as any).fullChat;
  if (fullChat instanceof Api.ChannelFull) {
    if (typeof (fullChat as any).about === "string") {
      const about = (fullChat as any).about.trim();
      out.description = about ? about : null;
    }
    if (typeof (fullChat as any).participantsCount === "number" && Number.isFinite((fullChat as any).participantsCount)) {
      out.memberCount = Math.max(0, Math.floor((fullChat as any).participantsCount));
    }
  }

  const chats: unknown = (result as any).chats;
  if (Array.isArray(chats)) {
    for (const chat of chats) {
      if (!(chat instanceof Api.Channel)) continue;
      const id = toBigIntOrNull((chat as any).id);
      if (id !== channelTelegramId) continue;

      out.name = typeof (chat as any).title === "string" && (chat as any).title.trim() ? (chat as any).title.trim() : undefined;
      out.username = typeof (chat as any).username === "string" && (chat as any).username.trim() ? (chat as any).username.trim() : null;
      out.accessHash = toBigIntOrNull((chat as any).accessHash);
      if (typeof (chat as any).noforwards === "boolean") out.isProtected = (chat as any).noforwards;

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

async function runChannelHealthCheck(client: TelegramClient, channel: HealthCheckChannelRow): Promise<void> {
  const input = new Api.InputChannel({
    channelId: returnBigInt(channel.telegramId),
    accessHash: returnBigInt(channel.accessHash),
  });

  const invokeOnce = () => client.invoke(new Api.channels.GetFullChannel({ channel: input }));

  let result: unknown;
  try {
    result = await invokeOnce();
  } catch (error: unknown) {
    const waitSeconds = parseFloodWaitSeconds(error);
    if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
      await sleep(waitSeconds * 1000);
      result = await invokeOnce();
    } else {
      throw error;
    }
  }

  const extracted = extractSourceChannelMetadataFromChatFull(result, channel.telegramId);

  await withDbRetry(
    () =>
      db
        .update(schema.sourceChannels)
        .set(
          omitUndefined({
            description: extracted.description,
            memberCount: extracted.memberCount,
            isProtected: extracted.isProtected,
            name: extracted.name,
            username: extracted.username,
            accessHash: extracted.accessHash,
            channelIdentifier: extracted.channelIdentifier,
          }),
        )
        .where(eq(schema.sourceChannels.id, channel.id)),
    `healthcheck update source metadata (channelId=${channel.id})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  const [historyTask] = await withDbRetry(
    () =>
      db
        .select({ status: schema.syncTasks.status })
        .from(schema.syncTasks)
        .where(and(eq(schema.syncTasks.sourceChannelId, channel.id), eq(schema.syncTasks.taskType, "history_full")))
        .orderBy(desc(schema.syncTasks.createdAt))
        .limit(1),
    `healthcheck lookup history_full status (channelId=${channel.id})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  const recoveredSyncStatus: (typeof schema.syncStatusEnum.enumValues)[number] =
    historyTask?.status === "completed"
      ? "completed"
      : historyTask?.status === "running"
        ? "syncing"
        : "pending";

  const recovered = await withDbRetry(
    () =>
      db
        .update(schema.sourceChannels)
        .set({ syncStatus: recoveredSyncStatus })
        .where(and(eq(schema.sourceChannels.id, channel.id), eq(schema.sourceChannels.syncStatus, "error")))
        .returning({ id: schema.sourceChannels.id }),
    `healthcheck recover syncStatus (channelId=${channel.id})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  if (recovered.length) {
    await logSyncEvent({
      sourceChannelId: channel.id,
      level: "info",
      message: `channel healthcheck recovered (syncStatus=${recoveredSyncStatus})`,
    });
  }
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
  if (maxComments <= 0) return;
  const link = buildSourceMessageLink(sourceChannel, sourcePostId);
  let processed = 0;

  try {
    await ensureOriginalLinkComment(client, { mirrorEntity, mirrorChannelId, mirrorPostId, sourceLink: link });

    const sendSingle = async (m: Api.Message) => {
      if (!m.id) return;
      if (m.fwdFrom && m.fwdFrom.channelPost) return;

      const rawText = typeof m.message === "string" ? m.message : "";
      const formattingEntities = Array.isArray(m.entities) ? m.entities : undefined;
      if (!rawText.trim() && !m.media) return;

        const sendOnce = async () => {
          if (m.media && !(m.media instanceof Api.MessageMediaWebPage)) {
            await client.sendFile(mirrorEntity as any, {
              file: (getSendFileMediaForMessage(m) ?? m.media) as any,
              caption: rawText,
              formattingEntities,
              commentTo: mirrorPostId,
            });
            return;
        }

        if (!rawText.trim()) return;
        await client.sendMessage(mirrorEntity as any, { message: rawText, formattingEntities, commentTo: mirrorPostId });
      };

      try {
        await sendOnce();
      } catch (error: unknown) {
        const waitSeconds = parseFloodWaitSeconds(error);
        if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
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

      const files = album.map((m) => (getSendFileMediaForMessage(m) ?? m.media) as any);
      const captions = album.map((m) => (typeof m.message === "string" ? m.message : ""));

      const sendOnce = async () => {
        await client.sendFile(mirrorEntity as any, {
          file: files,
          caption: captions,
          commentTo: mirrorPostId,
        });
      };

      try {
        await sendOnce();
      } catch (error: unknown) {
        const waitSeconds = parseFloodWaitSeconds(error);
        if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
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

  const randomIds = messageIds.map(() => generateRandomBigInt());
  const request = new Api.messages.ForwardMessages({
    fromPeer: fromInput as any,
    toPeer: toInput as any,
    id: messageIds,
    randomId: randomIds,
    dropAuthor: true,
  });

  const result = await client.invoke(request);
  const recovered = collectNewMessagesFromUpdatesResult(result);
  const recoveredById = new Map<number, Api.Message>();
  for (const msg of recovered) recoveredById.set(msg.id, msg);

  const idsByRandomId = collectMessageIdsByRandomIdFromUpdatesResult(result);

  const fallback = (() => {
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
  })();

  if (!idsByRandomId.size) return fallback;

  const mapped = messageIds.map((_, idx) => {
    const id = idsByRandomId.get(randomIds[idx]?.toString() ?? "");
    if (!id) return undefined;
    return recoveredById.get(id) ?? ({ id } as any as Api.Message);
  });

  if (!mapped.some(Boolean)) return fallback;
  return messageIds.map((_, idx) => mapped[idx] ?? fallback[idx]);
}

async function getTelegramClient(): Promise<TelegramClient> {
  const apiId = Number(requireEnv("TELEGRAM_API_ID"));
  const apiHash = requireEnv("TELEGRAM_API_HASH");

  const [row] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, "telegram_session"))
    .limit(1);

  const raw = row?.value;
  const encryptedSession =
    typeof raw === "string" ? raw : raw == null ? "" : typeof raw === "object" ? JSON.stringify(raw) : String(raw);

  const sessionString = decrypt(encryptedSession);
  if (!sessionString.trim()) throw new Error("Missing telegram_session in DB (settings.telegram_session)");

  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  const me = await client.getMe();
  const username = (me as any)?.username ? `@${(me as any).username}` : "";
  const firstName = (me as any)?.firstName ? String((me as any).firstName) : "";
  console.log(`mirror-service connected to Telegram as ${username || firstName || "unknown"}`);
  return client;
}

async function resolvePeer(client: TelegramClient, identifier: string) {
  const inviteHash = parseTelegramInviteHash(identifier);
  if (inviteHash) {
    const checked = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));

    if (checked instanceof Api.ChatInviteAlready) {
      const entity = (checked as any).chat;
      if (entity instanceof Api.Channel) {
        return {
          peerType: "channel" as const,
          telegramId: toBigIntOrNull(entity.id),
          accessHash: toBigIntOrNull(entity.accessHash),
          name: entity.title ?? identifier,
          username: entity.username ?? null,
          entity,
        };
      }
      if (entity instanceof Api.Chat) {
        return {
          peerType: "chat" as const,
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
      const chats: unknown = (imported as any)?.chats;
      const entity = Array.isArray(chats) ? chats.find((c) => c instanceof Api.Channel || c instanceof Api.Chat) : null;
      if (entity instanceof Api.Channel) {
        return {
          peerType: "channel" as const,
          telegramId: toBigIntOrNull(entity.id),
          accessHash: toBigIntOrNull(entity.accessHash),
          name: entity.title ?? checked.title ?? identifier,
          username: entity.username ?? null,
          entity,
        };
      }
      if (entity instanceof Api.Chat) {
        return {
          peerType: "chat" as const,
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
      peerType: "channel" as const,
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
      peerType: "user" as const,
      telegramId: toBigIntOrNull(entity.id),
      accessHash: toBigIntOrNull(entity.accessHash),
      name: name || entity.username || identifier,
      username: entity.username ?? null,
      entity,
    };
  }
  if (entity instanceof Api.Chat) {
    return {
      peerType: "chat" as const,
      telegramId: toBigIntOrNull(entity.id),
      accessHash: null,
      name: entity.title ?? identifier,
      username: null,
      entity,
    };
  }

  return {
    peerType: "other" as const,
    telegramId: null,
    accessHash: null,
    name: identifier,
    username: null,
    entity,
  };
}

async function markTaskFailed(taskId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
  console.error(`task failed: ${taskId} - ${message}`);

  let updated: Array<{
    sourceChannelId: string;
    taskType: (typeof schema.taskTypeEnum.enumValues)[number];
  }> = [];

  try {
    updated = await withDbRetry(
      () =>
        db
          .update(schema.syncTasks)
          .set({ status: "failed", lastError: message, completedAt: new Date() })
          .where(eq(schema.syncTasks.id, taskId))
          .returning({ sourceChannelId: schema.syncTasks.sourceChannelId, taskType: schema.syncTasks.taskType }),
      `mark task failed (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`failed to mark task failed: ${taskId}${getDbErrorMeta(e)} - ${msg}`);
  }

  const sourceChannelId = updated[0]?.sourceChannelId ?? null;
  const taskType = updated[0]?.taskType ?? null;

  void notifyTasksChanged({
    taskId,
    sourceChannelId: sourceChannelId ?? undefined,
    taskType: taskType ?? undefined,
    status: "failed",
  });

  if (sourceChannelId && (taskType === "resolve" || taskType === "history_full")) {
    try {
      await withDbRetry(
        () =>
          db
            .update(schema.sourceChannels)
            .set({ syncStatus: "error" })
            .where(eq(schema.sourceChannels.id, sourceChannelId)),
        `mark source channel error (taskId=${taskId}, taskType=${taskType})`,
        { attempts: 3, baseDelayMs: 250 },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`failed to mark source channel error: ${sourceChannelId}${getDbErrorMeta(e)} - ${msg}`);
    }
  }

  try {
    await logSyncEvent({
      sourceChannelId,
      level: "error",
      message: `task failed: ${taskType ?? "unknown"} (taskId=${taskId}) - ${message}`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`failed to log sync event: ${msg}`);
  }
}

async function pauseTask(
  taskId: string,
  reason: string,
  options?: {
    progressCurrent?: number;
    progressTotal?: number | null;
    lastProcessedId?: number | null;
  },
): Promise<void> {
  const set: Partial<typeof schema.syncTasks.$inferInsert> = {
    status: "paused",
    pausedAt: new Date(),
    lastError: reason,
  };

  if (typeof options?.progressCurrent === "number" && Number.isFinite(options.progressCurrent)) {
    set.progressCurrent = options.progressCurrent;
  }
  if (options?.progressTotal !== undefined) {
    set.progressTotal = options.progressTotal;
  }
  if (options?.lastProcessedId !== undefined) {
    set.lastProcessedId = options.lastProcessedId;
  }

  const updated = await withDbRetry(
    () =>
      db
        .update(schema.syncTasks)
        .set(set)
        .where(eq(schema.syncTasks.id, taskId))
        .returning({
          sourceChannelId: schema.syncTasks.sourceChannelId,
          taskType: schema.syncTasks.taskType,
          progressCurrent: schema.syncTasks.progressCurrent,
          progressTotal: schema.syncTasks.progressTotal,
          lastProcessedId: schema.syncTasks.lastProcessedId,
        }),
    `pause task (taskId=${taskId})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  const row = updated[0] ?? null;
  const progressCurrent = row?.progressCurrent;
  const progressTotal = row?.progressTotal ?? null;
  const lastProcessedId = row?.lastProcessedId ?? null;

  console.log(`task paused: ${taskId} - ${reason}`);

  void notifyTasksChanged({
    taskId,
    sourceChannelId: row?.sourceChannelId ?? undefined,
    taskType: row?.taskType ?? undefined,
    status: "paused",
  });

  const hasProgressInfo =
    (typeof progressCurrent === "number" && progressCurrent > 0) ||
    (typeof progressTotal === "number" && Number.isFinite(progressTotal)) ||
    (typeof lastProcessedId === "number" && Number.isFinite(lastProcessedId) && lastProcessedId > 0);

  const progressDetails = hasProgressInfo
    ? ` (progress=${progressCurrent ?? "-"}${progressTotal == null ? "" : `/${progressTotal}`} lastId=${lastProcessedId ?? "-"})`
    : "";

  await logSyncEvent({
    sourceChannelId: row?.sourceChannelId ?? null,
    level: "warn",
    message: `task paused: ${row?.taskType ?? "unknown"} (taskId=${taskId}) - ${reason}${progressDetails}`,
  });
}

async function requeueRunningTasks(reason: string): Promise<void> {
  const updated = await db
    .update(schema.syncTasks)
    .set({ status: "pending", startedAt: null, pausedAt: null })
    .where(eq(schema.syncTasks.status, "running"))
    .returning({ id: schema.syncTasks.id, taskType: schema.syncTasks.taskType });

  if (updated.length) {
    console.log(`requeued ${updated.length} running task(s) (${reason})`);
    await logSyncEvent({
      sourceChannelId: null,
      level: "info",
      message: `requeued ${updated.length} running task(s) (${reason})`,
    });
  }
}

function extractFirstChannelFromUpdates(result: unknown): Api.Channel | null {
  const chats: unknown = result && typeof result === "object" && "chats" in result ? (result as { chats?: unknown }).chats : undefined;
  if (!Array.isArray(chats)) return null;
  for (const chat of chats) {
    if (chat instanceof Api.Channel) return chat;
  }
  return null;
}

function extractInviteLinkFromExportedChatInvite(invite: unknown): string | null {
  if (invite instanceof Api.ChatInviteExported) {
    return typeof invite.link === "string" && invite.link.trim() ? invite.link.trim() : null;
  }
  if (invite && typeof invite === "object" && "link" in invite) {
    const maybe = (invite as { link?: unknown }).link;
    return typeof maybe === "string" && maybe.trim() ? maybe.trim() : null;
  }
  return null;
}

function buildAutoMirrorTitle(prefix: string, sourceName: string): string {
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
    const peer = (await client.getInputEntity(normalized as any)) as Api.TypeInputPeer;
    const inputUser = toInputUserFromInputPeer(peer);
    if (inputUser) return inputUser;
  } catch {
    // ignore and fallback
  }

  try {
    const entity = await client.getEntity(normalized as any);
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

async function ensureAutoChannelAdmins(
  client: TelegramClient,
  {
    sourceChannelId,
    channel,
    channelLabel,
    adminIdentifiers,
  }: { sourceChannelId: string; channel: Api.Channel; channelLabel: string; adminIdentifiers: string[] },
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
        if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
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
      if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
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

async function ensureDiscussionGroupForAutoMirrorChannel(
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
): Promise<string | null> {
  const existing = await getLinkedDiscussionChatFilter(client, mirrorChannel);
  if (existing) {
    const auto = await getAutoChannelSettings();
    if (auto.admins.length) {
      try {
        const resolved = await resolvePeer(client, existing);
        if (resolved.entity instanceof Api.Channel) {
          await ensureAutoChannelAdmins(client, {
            sourceChannelId,
            channel: resolved.entity,
            channelLabel: `discussion group ${existing}`,
            adminIdentifiers: auto.admins,
          });
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
    await ensureAutoChannelAdmins(client, {
      sourceChannelId,
      channel: createdGroup,
      channelLabel: `discussion group ${label}`,
      adminIdentifiers: auto.admins,
    });
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

async function processResolveTask(client: TelegramClient, taskId: string, sourceChannelId: string): Promise<void> {
  const [source] = await db.select().from(schema.sourceChannels).where(eq(schema.sourceChannels.id, sourceChannelId));
  if (!source) throw new Error(`source channel not found: ${sourceChannelId}`);

  if (!source.isActive) {
    await pauseTask(taskId, "source channel is disabled");
    return;
  }

  console.log(`resolve task start: ${taskId} source=${source.channelIdentifier}`);
  await logSyncEvent({ sourceChannelId: source.id, level: "info", message: `resolve started (taskId=${taskId})` });

  const [mirror] = await db
    .select()
    .from(schema.mirrorChannels)
    .where(eq(schema.mirrorChannels.sourceChannelId, source.id))
    .limit(1);

  const resolvedSource = await resolvePeer(client, source.channelIdentifier);
  if (!resolvedSource.telegramId) throw new Error(`failed to resolve source channel: ${source.channelIdentifier}`);

  const canonicalSourceIdentifier = buildCanonicalChannelIdentifier(resolvedSource, source.channelIdentifier);
  const sourceMetadata = await getSourceChannelMetadata(client, resolvedSource.entity);

  await withDbRetry(
    () =>
      db
        .update(schema.sourceChannels)
        .set(
          omitUndefined({
            channelIdentifier: canonicalSourceIdentifier,
            telegramId: resolvedSource.telegramId,
            accessHash: resolvedSource.accessHash,
            name: resolvedSource.name,
            username: resolvedSource.username,
            syncStatus: "pending",
            description: sourceMetadata.description,
            memberCount: sourceMetadata.memberCount,
            isProtected: sourceMetadata.isProtected,
          }),
        )
        .where(eq(schema.sourceChannels.id, source.id)),
    `resolve update source channel (taskId=${taskId})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  if (mirror) {
    if (mirror.isAutoCreated && !mirror.telegramId) {
      const auto = await getAutoChannelSettings();
      if (!auto.privateChannel) {
        await logSyncEvent({
          sourceChannelId: source.id,
          level: "warn",
          message: "auto_channel_private=false 暂未支持自动创建公开频道，将创建私密频道（无 username）。",
        });
      }

      const title = buildAutoMirrorTitle(auto.prefix, resolvedSource.name || source.channelIdentifier);
      const about = `tg-back mirror for ${canonicalSourceIdentifier}`;

      const created = await client.invoke(
        new Api.channels.CreateChannel({
          broadcast: true,
          title,
          about,
        }),
      );

      const createdChannel = extractFirstChannelFromUpdates(created);
      if (!createdChannel) throw new Error("failed to create mirror channel: no channel entity in updates");

      let inviteLink: string | null = null;
      try {
        const invite = await client.invoke(new Api.messages.ExportChatInvite({ peer: createdChannel }));
        inviteLink = extractInviteLinkFromExportedChatInvite(invite);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        console.warn(`failed to export mirror channel invite link: ${msg}`);
      }

      try {
        await ensureDiscussionGroupForAutoMirrorChannel(client, {
          sourceChannelId: source.id,
          sourceIdentifier: canonicalSourceIdentifier,
          sourceName: resolvedSource.name || source.channelIdentifier,
          mirrorChannel: createdChannel,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
        console.warn(`failed to link discussion group: ${msg}`);
        await logSyncEvent({
          sourceChannelId: source.id,
          level: "warn",
          message: `failed to link discussion group: ${msg}`,
        });
      }

      const resolvedMirror = {
        peerType: "channel" as const,
        telegramId: toBigIntOrNull(createdChannel.id),
        accessHash: toBigIntOrNull(createdChannel.accessHash),
        name: createdChannel.title ?? title,
        username: createdChannel.username ?? null,
      };

      if (!resolvedMirror.telegramId) throw new Error("failed to create mirror channel: missing telegram id");

      const canonicalMirrorIdentifier = buildCanonicalChannelIdentifier(
        resolvedMirror,
        `-100${resolvedMirror.telegramId.toString()}`,
      );

      await db
        .update(schema.mirrorChannels)
        .set({
          channelIdentifier: canonicalMirrorIdentifier,
          telegramId: resolvedMirror.telegramId,
          accessHash: resolvedMirror.accessHash,
          name: resolvedMirror.name,
          username: resolvedMirror.username,
          inviteLink,
          isAutoCreated: true,
        })
        .where(eq(schema.mirrorChannels.id, mirror.id));

      console.log(`auto mirror channel created: ${canonicalMirrorIdentifier}`);
      await logSyncEvent({
        sourceChannelId: source.id,
        level: "info",
        message: `auto mirror channel created: ${canonicalMirrorIdentifier}${inviteLink ? ` (invite=${inviteLink})` : ""}`,
      });

      if (auto.admins.length) {
        await ensureAutoChannelAdmins(client, {
          sourceChannelId: source.id,
          channel: createdChannel,
          channelLabel: `mirror channel ${canonicalMirrorIdentifier}`,
          adminIdentifiers: auto.admins,
        });
      }
    } else {
      const resolvedMirror = await resolvePeer(client, mirror.channelIdentifier);
      const canonicalMirrorIdentifier = buildCanonicalChannelIdentifier(resolvedMirror, mirror.channelIdentifier);

      if (mirror.isAutoCreated && resolvedMirror.entity instanceof Api.Channel) {
        const auto = await getAutoChannelSettings();
        if (auto.admins.length) {
          await ensureAutoChannelAdmins(client, {
            sourceChannelId: source.id,
            channel: resolvedMirror.entity,
            channelLabel: `mirror channel ${canonicalMirrorIdentifier}`,
            adminIdentifiers: auto.admins,
          });
        }

        try {
          await ensureDiscussionGroupForAutoMirrorChannel(client, {
            sourceChannelId: source.id,
            sourceIdentifier: canonicalSourceIdentifier,
            sourceName: resolvedSource.name || source.channelIdentifier,
            mirrorChannel: resolvedMirror.entity,
          });
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

      await db
        .update(schema.mirrorChannels)
        .set({
          channelIdentifier: canonicalMirrorIdentifier,
          telegramId: resolvedMirror.telegramId,
          accessHash: resolvedMirror.accessHash,
          name: resolvedMirror.name,
          username: resolvedMirror.username,
        })
        .where(eq(schema.mirrorChannels.id, mirror.id));
    }
  }

  await db
    .update(schema.syncTasks)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(schema.syncTasks.id, taskId));

  void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "resolve", status: "completed" });

  console.log(`resolve task done: ${taskId}`);
  await logSyncEvent({ sourceChannelId: source.id, level: "info", message: `resolve completed (taskId=${taskId})` });
}

async function processHistoryFullTask(client: TelegramClient, taskId: string, sourceChannelId: string): Promise<void> {
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
  console.log(`history_full task start: ${taskId} source=${source.channelIdentifier} mode=${mode}`);

  await withDbRetry(
    () =>
      db
        .update(schema.sourceChannels)
        .set({ syncStatus: "syncing" })
        .where(eq(schema.sourceChannels.id, source.id)),
    `history_full mark source syncing (taskId=${taskId})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  await logSyncEvent({
    sourceChannelId: source.id,
    level: "info",
    message: `history_full started mode=${mode} (taskId=${taskId}) resumeFromId=${task.lastProcessedId ?? 0} progress=${task.progressCurrent ?? 0}/${task.progressTotal ?? "-"}`,
  });

  const sourceEntity = (await resolvePeer(client, source.channelIdentifier)).entity;
  const mirrorEntity = (await resolvePeer(client, mirror.channelIdentifier)).entity;

  if (mirror.isAutoCreated && mirrorEntity instanceof Api.Channel) {
    const auto = await getAutoChannelSettings();
    if (auto.admins.length) {
      await ensureAutoChannelAdmins(client, {
        sourceChannelId: source.id,
        channel: mirrorEntity,
        channelLabel: `mirror channel ${mirror.channelIdentifier}`,
        adminIdentifiers: auto.admins,
      });
    }
  }

  const mirrorBehavior = await getMirrorBehaviorSettings();

  const syncCommentsEnabled = process.env.MIRROR_SYNC_COMMENTS?.trim() !== "false";
  const maxCommentsPerPostRaw = Number.parseInt(process.env.MIRROR_MAX_COMMENTS_PER_POST ?? "500", 10);
  const maxCommentsPerPost =
    Number.isFinite(maxCommentsPerPostRaw) && maxCommentsPerPostRaw > 0 ? Math.min(maxCommentsPerPostRaw, 10_000) : 500;

  const sourceDiscussionChatFilter = syncCommentsEnabled ? await getLinkedDiscussionChatFilter(client, sourceEntity) : null;
  let mirrorDiscussionChatFilter = syncCommentsEnabled ? await getLinkedDiscussionChatFilter(client, mirrorEntity) : null;

  if (syncCommentsEnabled && !mirrorDiscussionChatFilter && mirror.isAutoCreated && mirrorEntity instanceof Api.Channel) {
    try {
      mirrorDiscussionChatFilter = await ensureDiscussionGroupForAutoMirrorChannel(client, {
        sourceChannelId: source.id,
        sourceIdentifier: source.channelIdentifier,
        sourceName: source.name || source.channelIdentifier,
        mirrorChannel: mirrorEntity,
      });
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

  let reportedProtectedContent = false;

  console.log(
    `history_full task resume: ${taskId} lastProcessedId=${task.lastProcessedId ?? 0} progress=${task.progressCurrent ?? 0}/${task.progressTotal ?? "-"}`,
  );

  if (!task.startedAt) {
    await withDbRetry(
      () => db.update(schema.syncTasks).set({ startedAt: new Date() }).where(eq(schema.syncTasks.id, taskId)),
      `history_full set started_at (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
    void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "history_full", status: "running" });
  }

  let progressTotal: number | null = task.progressTotal ?? null;

  if (
    typeof progressTotal === "number" &&
    Number.isFinite(progressTotal) &&
    progressTotal > 0 &&
    (source.totalMessages == null || source.totalMessages !== progressTotal)
  ) {
    await withDbRetry(
      () => db.update(schema.sourceChannels).set({ totalMessages: progressTotal }).where(eq(schema.sourceChannels.id, source.id)),
      `history_full sync source total_messages (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
  }

  if (!task.progressTotal) {
    try {
      const list = await client.getMessages(sourceEntity, { limit: 0 });
      const total = typeof (list as any)?.total === "number" ? Number((list as any).total) : null;
      if (total && Number.isFinite(total)) {
        progressTotal = total;
        await withDbRetry(
          () => db.update(schema.syncTasks).set({ progressTotal }).where(eq(schema.syncTasks.id, taskId)),
          `history_full set progress_total (taskId=${taskId})`,
          { attempts: 3, baseDelayMs: 250 },
        );
        void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "history_full" });
        await withDbRetry(
          () => db.update(schema.sourceChannels).set({ totalMessages: progressTotal }).where(eq(schema.sourceChannels.id, source.id)),
          `history_full set source total_messages (taskId=${taskId})`,
          { attempts: 3, baseDelayMs: 250 },
        );
      }
    } catch {
      // ignore if total can't be fetched
    }
  }

  let snapshotLatestId: number | null = null;
  try {
    const latestList = await client.getMessages(sourceEntity, { limit: 1 });
    const latest = (latestList as any)?.[0];
    if (latest instanceof Api.Message && typeof latest.id === "number" && latest.id > 0) {
      snapshotLatestId = latest.id;
      console.log(`history_full snapshot latest source message id: ${snapshotLatestId}`);
      await logSyncEvent({
        sourceChannelId: source.id,
        level: "info",
        message: `history_full snapshot latestId=${snapshotLatestId} (taskId=${taskId})`,
      });
    }
  } catch (error: unknown) {
    const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
    console.warn(`failed to fetch history_full snapshot latest message id: ${msg}`);
    await logSyncEvent({
      sourceChannelId: source.id,
      level: "warn",
      message: `failed to fetch history_full snapshot latest message id: ${msg} (taskId=${taskId})`,
    });
  }

  let progressCurrent = task.progressCurrent ?? 0;
  let lastProcessedId = task.lastProcessedId ?? 0;

  let lastProgressLogAt = Date.now();
  let lastProgressLogValue = progressCurrent;

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
      await pauseTask(taskId, "paused by user", { progressCurrent, progressTotal, lastProcessedId });
      return false;
    }

    return true;
  };

  const logProgressIfNeeded = () => {
    const now = Date.now();
    if (now - lastProgressLogAt < 15_000 && progressCurrent - lastProgressLogValue < 200) return;
    lastProgressLogAt = now;
    lastProgressLogValue = progressCurrent;
    console.log(
      `history_full progress: ${taskId} ${progressCurrent}/${progressTotal ?? "-"} lastProcessedId=${lastProcessedId}`,
    );
  };

  let lastPersistAt = Date.now();
  let lastPersistedProgress = progressCurrent;
  let lastPersistedProcessedId = lastProcessedId;

  const persistProgress = async () => {
    const now = Date.now();
    if (now - lastPersistAt < 2_000 && progressCurrent - lastPersistedProgress < 50) return;
    await withDbRetry(
      () => db.update(schema.syncTasks).set({ progressCurrent, lastProcessedId }).where(eq(schema.syncTasks.id, taskId)),
      `history_full persist progress (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
    void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "history_full" });
    lastPersistAt = now;
    lastPersistedProgress = progressCurrent;
    lastPersistedProcessedId = lastProcessedId;
  };

  type PendingHistoryItem = { msg: Api.Message; mappingId: string };

  let pending: PendingHistoryItem[] = [];
  let pendingGroupId: string | null = null;

  const advanceProgressFor = async (msgId: number) => {
    lastProcessedId = msgId;
    progressCurrent += 1;
    await persistProgress();
    logProgressIfNeeded();
  };

  const flushPending = async (): Promise<"ok" | "paused"> => {
    if (!pending.length) return "ok";

    if (!(await ensureActiveOrPause())) return "paused";

    const items = [...pending].sort((a, b) => a.msg.id - b.msg.id);
    pending = [];
    pendingGroupId = null;

    const messageIds = items.map((i) => i.msg.id);
    const mappingIds = items.map((i) => i.mappingId);

    const messageFilter = await getEffectiveMessageFilterSettings(source.id);
    const shouldFilter =
      messageFilter.enabled &&
      messageFilter.keywords.length > 0 &&
      items.some((item) => shouldSkipMessageByFilter(typeof item.msg.message === "string" ? item.msg.message : "", messageFilter));

    if (shouldFilter) {
      await updateMessageMappingsByIds(
        mappingIds,
        { status: "skipped", skipReason: "filtered", mirroredAt: new Date(), errorMessage: null },
        "history_full skip:filtered",
      );
    } else if (mode === "forward") {
      const tryForwardOnce = async () =>
        await forwardMessagesAsCopy(client, { fromPeer: sourceEntity, toPeer: mirrorEntity, messageIds });

      let forwarded: (Api.Message | undefined)[] | null = null;
      for (;;) {
        try {
          forwarded = await tryForwardOnce();
          break;
        } catch (error: unknown) {
          const { skipReason } = classifyMirrorError(error);
          if (skipReason) {
            if (skipReason === "protected_content" && !reportedProtectedContent) {
              reportedProtectedContent = true;
              console.warn(
                `source channel has protected content enabled; Telegram blocks forwarding. Messages will be marked skipped (or task paused if skip_protected_content=false) and will not appear in the mirror channel.`,
              );
              await logSyncEvent({
                sourceChannelId: source.id,
                level: "warn",
                message: `protected content enabled; history_full forwarding blocked (taskId=${taskId})`,
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
                "history_full protected_content blocked",
              );
              await pauseTask(taskId, msg0, { progressCurrent, progressTotal, lastProcessedId });
              return "paused";
            }

            await updateMessageMappingsByIds(
              mappingIds,
              { status: "skipped", skipReason, mirroredAt: new Date(), errorMessage: null },
              `history_full skip:${skipReason}`,
            );
            forwarded = null;
            break;
          }

          const waitSeconds = parseFloodWaitSeconds(error);
          if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
            await sleep((waitSeconds + 1) * 1000);
            if (!(await ensureActiveOrPause())) return "paused";
            continue;
          }

          const msg1 = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
          await updateMessageMappingsByIds(
            mappingIds,
            { status: "failed", errorMessage: msg1, mirroredAt: new Date() },
            "history_full forward failed",
          );
          await pauseTask(taskId, msg1, { progressCurrent, progressTotal, lastProcessedId });
          return "paused";
        }
      }

      if (forwarded) {
        await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);

        let hasFailure = false;

        for (let i = 0; i < items.length; i += 1) {
          const mirrorMessageId = forwarded[i]?.id ?? null;
          if (mirrorMessageId == null) {
            hasFailure = true;
            await withDbRetry(
              () =>
                db
                  .update(schema.messageMappings)
                  .set({ status: "failed", errorMessage: "missing forwarded message mapping", mirroredAt: new Date() })
                  .where(eq(schema.messageMappings.id, items[i]!.mappingId)),
              `history_full mark failed (taskId=${taskId})`,
              { attempts: 3, baseDelayMs: 250 },
            );
          } else {
            await withDbRetry(
              () =>
                db
                  .update(schema.messageMappings)
                  .set({ status: "success", mirrorMessageId, mirroredAt: new Date(), errorMessage: null })
                  .where(eq(schema.messageMappings.id, items[i]!.mappingId)),
              `history_full mark success (taskId=${taskId})`,
              { attempts: 3, baseDelayMs: 250 },
            );
          }
        }

        if (hasFailure) {
          await pauseTask(taskId, "missing forwarded message mapping", { progressCurrent, progressTotal, lastProcessedId });
          return "paused";
        }

        for (let i = 0; i < items.length; i += 1) {
          const mirrorMessageId = forwarded[i]?.id ?? null;
          if (!mirrorMessageId) continue;
          await ensureMirrorMessageSpoiler(client, {
            mirrorPeer: mirrorEntity,
            mirrorMessageId,
            sourceMessage: items[i]!.msg,
            mirroredMessage: forwarded[i] ?? null,
          });
        }

        await withDbRetry(
          () =>
            db
              .update(schema.sourceChannels)
              .set({ lastSyncAt: new Date(), lastMessageId: messageIds[messageIds.length - 1] })
              .where(eq(schema.sourceChannels.id, source.id)),
          `history_full update source last_sync_at (taskId=${taskId})`,
          { attempts: 3, baseDelayMs: 250 },
        );

        if (canPostOriginalLinkComment) {
          const anchor = items[0]?.msg;
          const mirrorPostId = forwarded[0]?.id;
          if (anchor?.post && mirrorPostId) {
            const link = buildSourceMessageLink(source, anchor.id);
            await ensureOriginalLinkComment(client, { mirrorEntity, mirrorChannelId: mirror.id, mirrorPostId, sourceLink: link });
          }
        }

        if (canSyncComments) {
          for (let i = 0; i < items.length; i += 1) {
            const mirrorPostId = forwarded[i]?.id;
            const replies = items[i]!.msg.replies;
            if (!mirrorPostId) continue;
            if (!items[i]!.msg.post) continue;
            if (!(replies instanceof Api.MessageReplies) || replies.replies <= 0) continue;
            await syncCommentsForPost(client, {
              sourceEntity,
              mirrorEntity,
              mirrorChannelId: mirror.id,
              sourceChannel: source,
              sourcePostId: items[i]!.msg.id,
              mirrorPostId,
              maxComments: maxCommentsPerPost,
            });
          }
        }
      }
    } else {
      for (const item of items) {
        const msg = item.msg;
        const text = typeof msg.message === "string" ? msg.message : "";
        const content = text.trim();

        if (!content) {
          await withDbRetry(
            () =>
              db
                .update(schema.messageMappings)
                .set({ status: "skipped", skipReason: "unsupported_type", mirroredAt: new Date(), errorMessage: null })
                .where(eq(schema.messageMappings.id, item.mappingId)),
            `history_full copy skip unsupported (taskId=${taskId})`,
            { attempts: 3, baseDelayMs: 250 },
          );
          await advanceProgressFor(msg.id);
          continue;
        }

	        try {
	          const sent = await client.sendMessage(mirrorEntity, { message: content });
	          await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);
	          await withDbRetry(
	            () =>
	              db
	                .update(schema.messageMappings)
                .set({ status: "success", mirrorMessageId: sent?.id ?? null, mirroredAt: new Date(), errorMessage: null })
                .where(eq(schema.messageMappings.id, item.mappingId)),
            `history_full copy mark success (taskId=${taskId})`,
            { attempts: 3, baseDelayMs: 250 },
          );

          await withDbRetry(
            () =>
              db
                .update(schema.sourceChannels)
                .set({ lastSyncAt: new Date(), lastMessageId: msg.id })
                .where(eq(schema.sourceChannels.id, source.id)),
            `history_full copy update source last_sync_at (taskId=${taskId})`,
            { attempts: 3, baseDelayMs: 250 },
          );

          if (canPostOriginalLinkComment && sent?.id && msg.post) {
            const link = buildSourceMessageLink(source, msg.id);
            await ensureOriginalLinkComment(client, {
              mirrorEntity,
              mirrorChannelId: mirror.id,
              mirrorPostId: sent.id,
              sourceLink: link,
            });
          }

          if (canSyncComments && sent?.id && msg.post && msg.replies instanceof Api.MessageReplies && msg.replies.replies > 0) {
		            await syncCommentsForPost(client, {
		              sourceEntity,
		              mirrorEntity,
	              mirrorChannelId: mirror.id,
	              sourceChannel: source,
	              sourcePostId: msg.id,
	              mirrorPostId: sent.id,
	              maxComments: maxCommentsPerPost,
	            });
          }
	        } catch (error: unknown) {
	          const { skipReason } = classifyMirrorError(error);
	          if (skipReason) {
	            await withDbRetry(
              () =>
                db
                  .update(schema.messageMappings)
                  .set({ status: "skipped", skipReason, mirroredAt: new Date(), errorMessage: null })
                  .where(eq(schema.messageMappings.id, item.mappingId)),
              `history_full copy mark skipped (taskId=${taskId})`,
              { attempts: 3, baseDelayMs: 250 },
            );
	          } else {
	            const waitSeconds = parseFloodWaitSeconds(error);
	            if (waitSeconds && waitSeconds <= FLOOD_WAIT_AUTO_SLEEP_MAX_SEC) {
	              await sleep((waitSeconds + 1) * 1000);
	              if (!(await ensureActiveOrPause())) return "paused";
	              try {
	                const sent = await client.sendMessage(mirrorEntity, { message: content });
	                await throttleMirrorSend(mirrorBehavior.mirrorIntervalMs);
	                await withDbRetry(
	                  () =>
	                    db
	                      .update(schema.messageMappings)
	                      .set({ status: "success", mirrorMessageId: sent?.id ?? null, mirroredAt: new Date(), errorMessage: null })
	                      .where(eq(schema.messageMappings.id, item.mappingId)),
	                  `history_full copy mark success (taskId=${taskId})`,
	                  { attempts: 3, baseDelayMs: 250 },
	                );
	              } catch (error2: unknown) {
	                const msg2 = error2 instanceof Error ? error2.message : getTelegramErrorMessage(error2) ?? String(error2);
	                await withDbRetry(
	                  () =>
	                    db
	                      .update(schema.messageMappings)
	                      .set({ status: "failed", errorMessage: msg2, mirroredAt: new Date() })
	                      .where(eq(schema.messageMappings.id, item.mappingId)),
	                  `history_full copy mark failed (taskId=${taskId})`,
	                  { attempts: 3, baseDelayMs: 250 },
	                );
	                await pauseTask(taskId, msg2, { progressCurrent, progressTotal, lastProcessedId });
	                return "paused";
	              }
	            } else {
	              const msg1 = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
	              await withDbRetry(
	                () =>
	                  db
	                    .update(schema.messageMappings)
	                    .set({ status: "failed", errorMessage: msg1, mirroredAt: new Date() })
	                    .where(eq(schema.messageMappings.id, item.mappingId)),
	                `history_full copy mark failed (taskId=${taskId})`,
	                { attempts: 3, baseDelayMs: 250 },
	              );
	              await pauseTask(taskId, msg1, { progressCurrent, progressTotal, lastProcessedId });
	              return "paused";
	            }
	          }
	        }

	        await advanceProgressFor(msg.id);
      }

      return "ok";
    }

    for (const item of items) {
      await advanceProgressFor(item.msg.id);
    }

    return "ok";
  };

  let lastUnexpectedEndAt = 0;

  for (;;) {
    const roundStartedAt = Date.now();
    const roundStartProgress = progressCurrent;
    const roundStartLastId = lastProcessedId;

    for await (const msg of client.iterMessages(sourceEntity, { reverse: true, minId: lastProcessedId, waitTime: 1 })) {
      if (!(await ensureActiveOrPause())) return;
      if (!(msg instanceof Api.Message)) continue;
      if (!msg.id) continue;
      if (lastProcessedId && msg.id <= lastProcessedId) continue;

      const groupId = mode === "forward" && mirrorBehavior.groupMediaMessages && msg.groupedId ? String(msg.groupedId) : null;
      if (pending.length && pendingGroupId !== groupId) {
        const result = await flushPending();
        if (result === "paused") return;
      }

      const sentAt = new Date(msg.date * 1000);
      const text = typeof msg.message === "string" ? msg.message : "";
      const textPreview = text.length > 200 ? `${text.slice(0, 200)}` : text;
      const messageType = messageTypeFromMessage(msg);
      const mediaGroupId = msg.groupedId ? String(msg.groupedId) : null;
      const hasMedia = !!msg.media;
      const fileSize = extractMediaFileSize(msg);

      let status: (typeof schema.messageStatusEnum.enumValues)[number] = "pending";
      let skipReason: (typeof schema.skipReasonEnum.enumValues)[number] | null = null;
      let errorMessage: string | null = null;
      let mirroredAt: Date | null = null;

      if (hasMedia) {
        if (messageType === "video" && !mirrorBehavior.mirrorVideos) {
          status = "skipped";
          skipReason = "unsupported_type";
          errorMessage = "skipped: video disabled by settings";
          mirroredAt = new Date();
        } else if (
          mirrorBehavior.maxFileSizeBytes != null &&
          fileSize != null &&
          Number.isFinite(fileSize) &&
          fileSize > mirrorBehavior.maxFileSizeBytes
        ) {
          status = "skipped";
          skipReason = "file_too_large";
          errorMessage = `skipped: file too large (${Math.ceil(fileSize / 1024 / 1024)}MB > ${mirrorBehavior.maxFileSizeMb}MB)`;
          mirroredAt = new Date();
        }
      }

      const inserted = await withDbRetry(
        () =>
          db
            .insert(schema.messageMappings)
            .values({
              sourceChannelId: source.id,
              sourceMessageId: msg.id,
              mirrorChannelId: mirror.id,
              messageType,
              mediaGroupId,
              status,
              skipReason,
              errorMessage,
              hasMedia,
              fileSize: fileSize ?? null,
              text: text || null,
              textPreview: textPreview || null,
              sentAt,
              mirroredAt,
            })
            .onConflictDoNothing()
            .returning({ id: schema.messageMappings.id, status: schema.messageMappings.status }),
        `history_full upsert message_mapping (taskId=${taskId}, msgId=${msg.id})`,
        { attempts: 3, baseDelayMs: 250 },
      );

      let mappingId: string | null = inserted[0]?.id ?? null;
      let mappingStatus: (typeof schema.messageStatusEnum.enumValues)[number] | null = inserted[0]?.status ?? null;

      if (!mappingId) {
        const [existing] = await withDbRetry(
          () =>
            db
              .select({ id: schema.messageMappings.id, status: schema.messageMappings.status })
              .from(schema.messageMappings)
              .where(and(eq(schema.messageMappings.sourceChannelId, source.id), eq(schema.messageMappings.sourceMessageId, msg.id)))
              .limit(1),
          `history_full lookup message_mapping (taskId=${taskId}, msgId=${msg.id})`,
          { attempts: 3, baseDelayMs: 250 },
        );
        mappingId = existing?.id ?? null;
        mappingStatus = existing?.status ?? null;
      }

      if (!mappingId || !mappingStatus) {
        await advanceProgressFor(msg.id);
        continue;
      }

      if (mappingStatus === "success" || mappingStatus === "skipped") {
        await advanceProgressFor(msg.id);
        continue;
      }

      pendingGroupId = groupId;
      pending.push({ msg, mappingId });

      if (!groupId) {
        const result = await flushPending();
        if (result === "paused") return;
      }
    }

    const finalResult = await flushPending();
    if (finalResult === "paused") return;

    await withDbRetry(
      () => db.update(schema.syncTasks).set({ progressCurrent, lastProcessedId }).where(eq(schema.syncTasks.id, taskId)),
      `history_full finalize progress (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
    void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "history_full" });

    if (snapshotLatestId == null) {
      try {
        const latestList = await client.getMessages(sourceEntity, { limit: 1 });
        const latest = (latestList as any)?.[0];
        if (latest instanceof Api.Message && typeof latest.id === "number" && latest.id > 0) {
          snapshotLatestId = latest.id;
          console.log(`history_full snapshot latest source message id: ${snapshotLatestId}`);
          await logSyncEvent({
            sourceChannelId: source.id,
            level: "info",
            message: `history_full snapshot latestId=${snapshotLatestId} (taskId=${taskId})`,
          });
        }
      } catch {
        // ignore
      }
    }

    const remainingByProgress =
      typeof progressTotal === "number" && Number.isFinite(progressTotal) ? Math.max(0, progressTotal - progressCurrent) : null;
    const remainingById =
      typeof snapshotLatestId === "number" && Number.isFinite(snapshotLatestId) && snapshotLatestId > 0
        ? Math.max(0, snapshotLatestId - lastProcessedId)
        : null;

    const looksIncomplete = (remainingById != null && remainingById > 0) || (remainingByProgress != null && remainingByProgress > 0);
    if (!looksIncomplete) break;

    const progressedThisRound = progressCurrent > roundStartProgress || lastProcessedId > roundStartLastId;
    const details = `history_full seems incomplete; auto continuing (taskId=${taskId}) progress=${progressCurrent}/${progressTotal ?? "-"} lastId=${lastProcessedId}${snapshotLatestId ? ` snapshotLatestId=${snapshotLatestId}` : ""}`;

    if (!progressedThisRound) {
      await pauseTask(taskId, `${details} (no progress in last round)`, { progressCurrent, progressTotal, lastProcessedId });
      return;
    }

    console.warn(details);

    if (roundStartedAt - lastUnexpectedEndAt > 60_000) {
      lastUnexpectedEndAt = roundStartedAt;
      await logSyncEvent({ sourceChannelId: source.id, level: "warn", message: details });
    }

    if (!(await ensureActiveOrPause())) return;
    await sleep(1000);
  }

  await withDbRetry(
    () =>
      db
        .update(schema.syncTasks)
        .set({ status: "completed", completedAt: new Date(), lastError: null })
        .where(eq(schema.syncTasks.id, taskId)),
    `history_full mark completed (taskId=${taskId})`,
    { attempts: 3, baseDelayMs: 250 },
  );
  void notifyTasksChanged({ taskId, sourceChannelId: source.id, taskType: "history_full", status: "completed" });

  await withDbRetry(
    () =>
      db
        .update(schema.sourceChannels)
        .set({ syncStatus: "completed" })
        .where(eq(schema.sourceChannels.id, source.id)),
    `history_full mark source completed (taskId=${taskId})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  console.log(`history_full task done: ${taskId}`);
  await logSyncEvent({
    sourceChannelId: source.id,
    level: "info",
    message: `history_full completed (taskId=${taskId}) progress=${progressCurrent}/${progressTotal ?? "-"} lastId=${lastProcessedId}`,
  });
}

async function processRetryFailedTask(client: TelegramClient, taskId: string, sourceChannelId: string): Promise<void> {
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
      mirrorDiscussionChatFilter = await ensureDiscussionGroupForAutoMirrorChannel(client, {
        sourceChannelId: source.id,
        sourceIdentifier: source.channelIdentifier,
        sourceName: source.name || source.channelIdentifier,
        mirrorChannel: mirrorEntity,
      });
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
    } catch {
      // ignore
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
    } catch {
      // ignore
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
        const list = await client.getMessages(sourceEntity as any, { ids: messageIds });
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
          const sent = await client.sendMessage(mirrorEntity as any, { message: content });
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
                const sent = await client.sendMessage(mirrorEntity as any, { message: content });
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
        mirrorDiscussionChatFilter = await ensureDiscussionGroupForAutoMirrorChannel(this.client, {
          sourceChannelId: source.id,
          sourceIdentifier: source.channelIdentifier,
          sourceName: source.name || source.channelIdentifier,
          mirrorChannel: mirrorEntity,
        });
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
          } catch {
            // ignore
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
            } catch {
              // ignore
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
        }, 900);
        return;
      }

      const timeout = setTimeout(() => {
        flushMediaGroup(groupId).catch((e) => console.error("flush media group error:", e));
      }, 900);

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
                  await this.client.sendFile(mirrorEntity as any, {
                    file: (getSendFileMediaForMessage(m) ?? m.media) as any,
                    caption: rawText,
                    formattingEntities,
                    commentTo: entry.mirrorPostId,
                  });
                  return;
                }
              if (rawText.trim()) {
                await this.client.sendMessage(mirrorEntity as any, {
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

            const files = album.map((m) => (getSendFileMediaForMessage(m) ?? m.media) as any);
            const captions = album.map((m) => (typeof m.message === "string" ? m.message : ""));

            const sendOnce = async () => {
              await this.client.sendFile(mirrorEntity as any, {
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
            }, 900);
            return;
          }

          const timeout = setTimeout(() => {
            flushDiscussionMediaGroup(key).catch((e) => console.error("flush discussion media group error:", e));
          }, 900);
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
                new Api.messages.GetDiscussionMessage({ peer: discussionEntity as any, msgId: message.id }),
              );

              const sourceChannelIdStr = source.telegramId ? String(source.telegramId) : "";
              const related = (discussion as any)?.messages?.find((m: any) => {
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
                  await this.client.sendFile(mirrorEntity as any, {
                    file: (getSendFileMediaForMessage(message) ?? message.media) as any,
                    caption: rawText,
                    formattingEntities,
                    commentTo: mirrorPostId,
                  });
                  return;
                }
                if (rawText.trim()) {
                  await this.client.sendMessage(mirrorEntity as any, {
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

async function loop(): Promise<void> {
  const client = await getTelegramClient();
  const realtime = new RealtimeManager(client);
  const healthSettings = getChannelHealthCheckSettings();
  const serviceStartedAt = new Date();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight = false;

  await logSyncEvent({ sourceChannelId: null, level: "info", message: "mirror-service started" });
  await requeueRunningTasks("startup");

  const runningTasks = new Map<string, Promise<void>>();
  const runningChannelIds = new Set<string>();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        await requeueRunningTasks(signal);
      } catch {
        // ignore
      }
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await writeMirrorServiceHeartbeat(serviceStartedAt);
  heartbeatTimer = setInterval(() => {
    if (shuttingDown) return;
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void writeMirrorServiceHeartbeat(serviceStartedAt).finally(() => {
      heartbeatInFlight = false;
    });
  }, MIRROR_SERVICE_HEARTBEAT_INTERVAL_MS);

  let lastRealtimeEnsure = 0;
  let lastRetryEnsure = 0;
  let lastHealthEnsure = 0;
  let lastHealthReloadAt = 0;
  let healthChannels: HealthCheckChannelRow[] = [];
  let healthIndex = 0;
  let lastConcurrencyLogAt = 0;
  let lastConcurrencyValue = 0;

  const startTask = (task: { id: string; taskType: (typeof schema.taskTypeEnum.enumValues)[number]; sourceChannelId: string }) => {
    runningChannelIds.add(task.sourceChannelId);
    const promise = (async () => {
      try {
        if (task.taskType === "resolve") {
          await processResolveTask(client, task.id, task.sourceChannelId);
          return;
        }
        if (task.taskType === "history_full") {
          await processHistoryFullTask(client, task.id, task.sourceChannelId);
          return;
        }
        if (task.taskType === "retry_failed") {
          await processRetryFailedTask(client, task.id, task.sourceChannelId);
          return;
        }
        await markTaskFailed(task.id, new Error(`unsupported task type: ${task.taskType}`));
      } catch (error: unknown) {
        await markTaskFailed(task.id, error);
      }
    })().finally(() => {
      runningTasks.delete(task.id);
      runningChannelIds.delete(task.sourceChannelId);
    });

    runningTasks.set(task.id, promise);
  };

  const claimPendingTask = async (
    taskType: (typeof schema.taskTypeEnum.enumValues)[number],
  ): Promise<{ id: string; taskType: (typeof schema.taskTypeEnum.enumValues)[number]; sourceChannelId: string } | null> => {
    const row =
      taskType === "resolve"
        ? (
            await withDbRetry(
              () =>
                db
                  .select({ id: schema.syncTasks.id, sourceChannelId: schema.syncTasks.sourceChannelId })
                  .from(schema.syncTasks)
                  .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.syncTasks.sourceChannelId))
                  .where(
                    and(
                      eq(schema.syncTasks.status, "pending"),
                      eq(schema.syncTasks.taskType, taskType),
                      eq(schema.sourceChannels.isActive, true),
                      ne(schema.sourceChannels.syncStatus, "error"),
                      runningChannelIds.size ? notInArray(schema.syncTasks.sourceChannelId, [...runningChannelIds]) : undefined,
                    ),
                  )
                  .orderBy(desc(schema.sourceChannels.priority), asc(schema.syncTasks.createdAt))
                  .limit(1),
              `claim pending task (${taskType})`,
              { attempts: 3, baseDelayMs: 250 },
            )
          )[0]
        : (
            await withDbRetry(
              () =>
                db
                  .select({ id: schema.syncTasks.id, sourceChannelId: schema.syncTasks.sourceChannelId })
                  .from(schema.syncTasks)
                  .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.syncTasks.sourceChannelId))
                  .innerJoin(schema.mirrorChannels, eq(schema.mirrorChannels.sourceChannelId, schema.syncTasks.sourceChannelId))
                  .where(
                    and(
                      eq(schema.syncTasks.status, "pending"),
                      eq(schema.syncTasks.taskType, taskType),
                      eq(schema.sourceChannels.isActive, true),
                      ne(schema.sourceChannels.syncStatus, "error"),
                      runningChannelIds.size ? notInArray(schema.syncTasks.sourceChannelId, [...runningChannelIds]) : undefined,
                      sql`${schema.sourceChannels.telegramId} is not null`,
                      sql`${schema.mirrorChannels.telegramId} is not null`,
                    ),
                  )
                  .orderBy(desc(schema.sourceChannels.priority), asc(schema.syncTasks.createdAt))
                  .limit(1),
              `claim pending task (${taskType})`,
              { attempts: 3, baseDelayMs: 250 },
            )
          )[0];

    if (!row) return null;

    const claimed = await withDbRetry(
      () =>
        db
          .update(schema.syncTasks)
          .set({ status: "running", startedAt: new Date() })
          .where(and(eq(schema.syncTasks.id, row.id), eq(schema.syncTasks.status, "pending")))
          .returning({ id: schema.syncTasks.id }),
      `claim task row (taskType=${taskType}, taskId=${row.id})`,
      { attempts: 3, baseDelayMs: 250 },
    );

    if (!claimed.length) return null;
    void notifyTasksChanged({ taskId: row.id, sourceChannelId: row.sourceChannelId, taskType, status: "running" });
    return { id: row.id, taskType, sourceChannelId: row.sourceChannelId };
  };

  const ensureRetryFailedTasks = async (): Promise<void> => {
    const { maxRetryCount, retryIntervalSec } = await getRetryBehaviorSettings();
    if (maxRetryCount <= 0) return;

    const threshold = retryIntervalSec > 0 ? new Date(Date.now() - retryIntervalSec * 1000) : null;

    const whereConditions: any[] = [
      eq(schema.messageMappings.status, "failed"),
      lt(schema.messageMappings.retryCount, maxRetryCount),
      or(isNull(schema.messageMappings.skipReason), ne(schema.messageMappings.skipReason, "protected_content")),
      eq(schema.sourceChannels.isActive, true),
      sql`${schema.sourceChannels.telegramId} is not null`,
      sql`${schema.mirrorChannels.telegramId} is not null`,
    ];

    if (threshold) {
      whereConditions.push(or(isNull(schema.messageMappings.mirroredAt), lt(schema.messageMappings.mirroredAt, threshold)));
    }

    const candidates = await withDbRetry(
      () =>
        db
          .select({ sourceChannelId: schema.messageMappings.sourceChannelId })
          .from(schema.messageMappings)
          .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.messageMappings.sourceChannelId))
          .innerJoin(schema.mirrorChannels, eq(schema.mirrorChannels.sourceChannelId, schema.messageMappings.sourceChannelId))
          .where(and(...whereConditions))
          .groupBy(schema.messageMappings.sourceChannelId)
          .limit(20),
      "ensure retry_failed candidates",
      { attempts: 3, baseDelayMs: 250 },
    );

    if (!candidates.length) return;

    const sourceChannelIds = candidates.map((c) => c.sourceChannelId);

    const existing = await withDbRetry(
      () =>
        db
          .select({
            id: schema.syncTasks.id,
            sourceChannelId: schema.syncTasks.sourceChannelId,
            status: schema.syncTasks.status,
            lastError: schema.syncTasks.lastError,
            createdAt: schema.syncTasks.createdAt,
          })
          .from(schema.syncTasks)
          .where(and(inArray(schema.syncTasks.sourceChannelId, sourceChannelIds), eq(schema.syncTasks.taskType, "retry_failed")))
          .orderBy(desc(schema.syncTasks.createdAt)),
      "ensure retry_failed tasks",
      { attempts: 3, baseDelayMs: 250 },
    );

    const taskByChannel = new Map<string, (typeof existing)[number]>();
    for (const row of existing) {
      if (!taskByChannel.has(row.sourceChannelId)) taskByChannel.set(row.sourceChannelId, row);
    }

    const inserts: Array<typeof schema.syncTasks.$inferInsert> = [];

    for (const channelId of sourceChannelIds) {
      const task = taskByChannel.get(channelId) ?? null;
      if (!task) {
        inserts.push({ sourceChannelId: channelId, taskType: "retry_failed", status: "pending" });
        continue;
      }

      if (task.status === "pending" || task.status === "running") continue;
      if (task.status === "paused") continue;

      await withDbRetry(
        () =>
          db
            .update(schema.syncTasks)
            .set({
              status: "pending",
              startedAt: null,
              pausedAt: null,
              completedAt: null,
              lastError: null,
              progressCurrent: 0,
              progressTotal: null,
              lastProcessedId: null,
            })
            .where(eq(schema.syncTasks.id, task.id)),
        `requeue retry_failed (taskId=${task.id})`,
        { attempts: 3, baseDelayMs: 250 },
      );
    }

    if (inserts.length) {
      await withDbRetry(() => db.insert(schema.syncTasks).values(inserts), `create retry_failed tasks (n=${inserts.length})`, {
        attempts: 3,
        baseDelayMs: 250,
      });
    }
  };

  const reloadHealthChannels = async (): Promise<void> => {
    if (!healthSettings.enabled) return;
    const rows = await withDbRetry(
      () =>
        db
          .select({
            id: schema.sourceChannels.id,
            channelIdentifier: schema.sourceChannels.channelIdentifier,
            telegramId: schema.sourceChannels.telegramId,
            accessHash: schema.sourceChannels.accessHash,
          })
          .from(schema.sourceChannels)
          .where(
            and(
              eq(schema.sourceChannels.isActive, true),
              sql`${schema.sourceChannels.telegramId} is not null`,
              sql`${schema.sourceChannels.accessHash} is not null`,
            ),
          )
          .orderBy(desc(schema.sourceChannels.priority), desc(schema.sourceChannels.subscribedAt)),
      "healthcheck load channels",
      { attempts: 3, baseDelayMs: 250 },
    );

    healthChannels = rows
      .filter((row) => typeof row.telegramId === "bigint" && typeof row.accessHash === "bigint")
      .map((row) => ({
        id: row.id,
        channelIdentifier: row.channelIdentifier,
        telegramId: row.telegramId!,
        accessHash: row.accessHash!,
      }));

    if (healthIndex >= healthChannels.length) healthIndex = 0;
  };

  const ensureChannelHealthChecks = async (now: number): Promise<void> => {
    if (!healthSettings.enabled) return;

    if (now - lastHealthReloadAt > healthSettings.refreshMs || !healthChannels.length) {
      lastHealthReloadAt = now;
      await reloadHealthChannels();
    }

    if (!healthChannels.length) return;
    if (now - lastHealthEnsure < healthSettings.intervalMs) return;
    lastHealthEnsure = now;

    const batch = Math.min(healthSettings.batchSize, healthChannels.length);
    for (let i = 0; i < batch; i += 1) {
      if (!healthChannels.length) return;
      if (healthIndex >= healthChannels.length) healthIndex = 0;
      const channel = healthChannels[healthIndex]!;
      healthIndex += 1;

      try {
        await runChannelHealthCheck(client, channel);
      } catch (error: unknown) {
        const msg = getTelegramErrorMessage(error) ?? (error instanceof Error ? error.message : String(error));
        if (!isChannelInaccessibleError(error)) {
          console.warn(`healthcheck failed (ignored): channel=${channel.channelIdentifier} - ${msg}`);
          continue;
        }

        const marked = await withDbRetry(
          () =>
            db
              .update(schema.sourceChannels)
              .set({ syncStatus: "error" })
              .where(and(eq(schema.sourceChannels.id, channel.id), ne(schema.sourceChannels.syncStatus, "error")))
              .returning({ id: schema.sourceChannels.id }),
          `healthcheck mark channel error (channelId=${channel.id})`,
          { attempts: 3, baseDelayMs: 250 },
        );

        if (marked.length) {
          await logSyncEvent({
            sourceChannelId: channel.id,
            level: "error",
            message: `channel healthcheck failed: ${msg}`,
          });
        }
      }
    }
  };

  const FLOOD_WAIT_AUTO_RESUME_CHECK_MS = 5_000;
  let lastFloodWaitAutoResumeAt = 0;

  const ensureFloodWaitAutoResume = async (now: number): Promise<void> => {
    if (now - lastFloodWaitAutoResumeAt < FLOOD_WAIT_AUTO_RESUME_CHECK_MS) return;
    lastFloodWaitAutoResumeAt = now;

    const rows = await withDbRetry(
      () =>
        db
          .select({
            id: schema.syncTasks.id,
            sourceChannelId: schema.syncTasks.sourceChannelId,
            taskType: schema.syncTasks.taskType,
            pausedAt: schema.syncTasks.pausedAt,
            lastError: schema.syncTasks.lastError,
          })
          .from(schema.syncTasks)
          .where(
            and(
              eq(schema.syncTasks.status, "paused"),
              sql`${schema.syncTasks.pausedAt} is not null`,
              sql`${schema.syncTasks.lastError} is not null`,
            ),
          )
          .orderBy(asc(schema.syncTasks.pausedAt))
          .limit(50),
      "auto resume flood wait tasks",
      { attempts: 3, baseDelayMs: 250 },
    );

    for (const row of rows) {
      if (!row.pausedAt) continue;
      const waitSeconds = parseFloodWaitSeconds(row.lastError ?? "");
      if (!waitSeconds || !Number.isFinite(waitSeconds) || waitSeconds <= 0) continue;

      const resumeAtMs = row.pausedAt.getTime() + (waitSeconds + 1) * 1000;
      if (now < resumeAtMs) continue;

      await withDbRetry(
        () =>
          db
            .update(schema.syncTasks)
            .set({ status: "pending", startedAt: null, pausedAt: null, lastError: null })
            .where(eq(schema.syncTasks.id, row.id)),
        `auto resume flood wait (taskId=${row.id})`,
        { attempts: 3, baseDelayMs: 250 },
      );

      void notifyTasksChanged({ taskId: row.id, sourceChannelId: row.sourceChannelId, taskType: row.taskType, status: "pending" });

      await logSyncEvent({
        sourceChannelId: row.sourceChannelId,
        level: "info",
        message: `auto resumed task after FLOOD_WAIT_${waitSeconds}s (taskId=${row.id}, taskType=${row.taskType})`,
      });
    }
  };

  for (;;) {
    try {
      const now = Date.now();
      if (now - lastRealtimeEnsure > 5_000) {
        lastRealtimeEnsure = now;
        await realtime.ensure();
      }

      if (now - lastRetryEnsure > 10_000) {
        lastRetryEnsure = now;
        await ensureRetryFailedTasks();
      }

      await ensureFloodWaitAutoResume(now);
      await ensureChannelHealthChecks(now);

      const { concurrentMirrors } = await getTaskRunnerSettings();
      if (concurrentMirrors !== lastConcurrencyValue && now - lastConcurrencyLogAt > 3_000) {
        lastConcurrencyValue = concurrentMirrors;
        lastConcurrencyLogAt = now;
        console.log(`task runner concurrency: ${concurrentMirrors}`);
      }

      let startedAny = false;

      while (runningTasks.size < concurrentMirrors) {
        const task =
          (await claimPendingTask("resolve")) ??
          (await claimPendingTask("history_full")) ??
          (await claimPendingTask("retry_failed"));

        if (!task) break;
        startTask(task);
        startedAny = true;
      }

      if (!startedAny) {
        await sleep(1_000);
        continue;
      }

      await sleep(200);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`task runner loop error: ${msg}`);
      await sleep(1_000);
    }
  }
}

loop().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
