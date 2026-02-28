import { eq, inArray } from "drizzle-orm";
import { db, parseSettingValue, schema } from "@tg-back/db";
import { withDbRetry } from "./db-retry";
import { sleep } from "../utils/sleep";

const SETTINGS_CACHE_MS = 5_000;
const warnedAt = new Map<string, number>();

function warnOnce(key: string, message: string, intervalMs = 60_000): void {
  const now = Date.now();
  const lastAt = warnedAt.get(key) ?? 0;
  if (lastAt && now - lastAt < intervalMs) return;
  warnedAt.set(key, now);
  console.warn(message);
}

function createCachedLoader<T>(
  cacheMs: number,
  loadFresh: () => Promise<T>,
  onError: (error: unknown, cached: T | null) => T,
): () => Promise<T> {
  let cached: T | null = null;
  let cachedAt = 0;

  return async () => {
    const now = Date.now();
    if (cached && now - cachedAt < cacheMs) return cached;

    try {
      const fresh = await loadFresh();
      cached = fresh;
      cachedAt = now;
      return fresh;
    } catch (error: unknown) {
      const fallback = onError(error, cached);
      cached = fallback;
      cachedAt = now;
      return fallback;
    }
  };
}

async function loadSettingsRows(keys: readonly string[], label: string): Promise<Array<{ key: string; value: unknown }>> {
  return await withDbRetry(
    () =>
      db
        .select({ key: schema.settings.key, value: schema.settings.value })
        .from(schema.settings)
        .where(inArray(schema.settings.key, keys as unknown as string[])),
    label,
    { attempts: 3, baseDelayMs: 250 },
  );
}

type RuntimeSettings = {
  syncMessageEdits: boolean;
  keepEditHistory: boolean;
  syncMessageDeletions: boolean;
};

const loadRuntimeSettings = createCachedLoader<RuntimeSettings>(
  SETTINGS_CACHE_MS,
  async () => {
    const keys = ["sync_message_edits", "keep_edit_history", "sync_message_deletions"] as const;
    const rows = await loadSettingsRows(keys, "load runtime settings");
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const syncMessageEdits = parseSettingValue("sync_message_edits", map.get("sync_message_edits"));
    const keepEditHistory = parseSettingValue("keep_edit_history", map.get("keep_edit_history"));
    const syncMessageDeletions = parseSettingValue("sync_message_deletions", map.get("sync_message_deletions"));

    return { syncMessageEdits, keepEditHistory, syncMessageDeletions };
  },
  (error: unknown, cached: RuntimeSettings | null) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to load runtime settings; using defaults: ${msg}`);
    return (
      cached ?? {
        syncMessageEdits: schema.defaultSettings.sync_message_edits === true,
        keepEditHistory: schema.defaultSettings.keep_edit_history === true,
        syncMessageDeletions: schema.defaultSettings.sync_message_deletions === true,
      }
    );
  },
);

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  return await loadRuntimeSettings();
}

type MirrorBehaviorSettings = {
  mirrorIntervalMs: number;
  mirrorVideos: boolean;
  maxFileSizeMb: number;
  maxFileSizeBytes: number | null;
  skipProtectedContent: boolean;
  groupMediaMessages: boolean;
  mediaGroupBufferMs: number;
};

const loadMirrorBehaviorSettings = createCachedLoader<MirrorBehaviorSettings>(
  SETTINGS_CACHE_MS,
  async () => {
    const keys = [
      "mirror_interval_ms",
      "mirror_videos",
      "max_file_size_mb",
      "skip_protected_content",
      "group_media_messages",
      "media_group_buffer_ms",
    ] as const;
    const rows = await loadSettingsRows(keys, "load mirror behavior settings");
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const mirrorIntervalMsRaw = parseSettingValue("mirror_interval_ms", map.get("mirror_interval_ms"));
    const mirrorIntervalMs = Math.min(10_000, Math.max(0, Math.floor(mirrorIntervalMsRaw)));

    const mirrorVideos = parseSettingValue("mirror_videos", map.get("mirror_videos"));

    const maxFileSizeMbRaw = parseSettingValue("max_file_size_mb", map.get("max_file_size_mb"));
    const maxFileSizeMb = Math.min(10_000, Math.max(0, Math.floor(maxFileSizeMbRaw)));
    const maxFileSizeBytes = maxFileSizeMb > 0 ? maxFileSizeMb * 1024 * 1024 : null;

    const skipProtectedContent = parseSettingValue("skip_protected_content", map.get("skip_protected_content"));

    const groupMediaMessages = parseSettingValue("group_media_messages", map.get("group_media_messages"));

    const mediaGroupBufferMsRaw = parseSettingValue("media_group_buffer_ms", map.get("media_group_buffer_ms"));
    const mediaGroupBufferMs = Math.min(10_000, Math.max(200, Math.floor(mediaGroupBufferMsRaw)));

    return {
      mirrorIntervalMs,
      mirrorVideos,
      maxFileSizeMb,
      maxFileSizeBytes,
      skipProtectedContent,
      groupMediaMessages,
      mediaGroupBufferMs,
    };
  },
  (error: unknown, cached: MirrorBehaviorSettings | null) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to load mirror behavior settings; using defaults: ${msg}`);
    return (
      cached ?? {
        mirrorIntervalMs: schema.defaultSettings.mirror_interval_ms,
        mirrorVideos: schema.defaultSettings.mirror_videos === true,
        maxFileSizeMb: schema.defaultSettings.max_file_size_mb,
        maxFileSizeBytes: schema.defaultSettings.max_file_size_mb > 0 ? schema.defaultSettings.max_file_size_mb * 1024 * 1024 : null,
        skipProtectedContent: schema.defaultSettings.skip_protected_content === true,
        groupMediaMessages: schema.defaultSettings.group_media_messages === true,
        mediaGroupBufferMs: schema.defaultSettings.media_group_buffer_ms,
      }
    );
  },
);

export async function getMirrorBehaviorSettings(): Promise<MirrorBehaviorSettings> {
  return await loadMirrorBehaviorSettings();
}

type MessageFilterSettings = {
  enabled: boolean;
  keywords: string[];
};

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

const loadMessageFilterSettings = createCachedLoader<MessageFilterSettings>(
  SETTINGS_CACHE_MS,
  async () => {
    const keys = ["message_filter_enabled", "message_filter_keywords"] as const;
    const rows = await loadSettingsRows(keys, "load message filter settings");
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const enabled = parseSettingValue("message_filter_enabled", map.get("message_filter_enabled"));
    const keywordsRaw = parseSettingValue("message_filter_keywords", map.get("message_filter_keywords"));
    const keywords = enabled ? parseMessageFilterKeywords(keywordsRaw) : [];

    return { enabled, keywords };
  },
  (error: unknown, cached: MessageFilterSettings | null) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to load message filter settings; using defaults: ${msg}`);
    return cached ?? { enabled: false, keywords: [] };
  },
);

async function getMessageFilterSettings(): Promise<MessageFilterSettings> {
  return await loadMessageFilterSettings();
}

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
  if (cached && now - cached.at < SETTINGS_CACHE_MS) {
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
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    warnOnce(
      "settings:channel-message-filter",
      `failed to load channel message filter settings; using defaults (sourceChannelId=${sourceChannelId}): ${msg}`,
    );
    cachedChannelMessageFilterSettings.set(sourceChannelId, { at: now, mode: "inherit", keywords: "" });
    return { mode: "inherit", keywords: "" };
  }
}

export async function getEffectiveMessageFilterSettings(sourceChannelId: string): Promise<MessageFilterSettings> {
  const channelSettings = await getChannelMessageFilterSettings(sourceChannelId);
  if (channelSettings.mode === "disabled") return { enabled: false, keywords: [] };
  if (channelSettings.mode === "custom") {
    return { enabled: true, keywords: parseMessageFilterKeywords(channelSettings.keywords) };
  }
  return await getMessageFilterSettings();
}

export function shouldSkipMessageByFilter(text: string, filter: MessageFilterSettings): boolean {
  if (!filter.enabled || !filter.keywords.length) return false;
  const content = text.trim();
  if (!content) return false;
  const haystack = content.toLowerCase();
  for (const keyword of filter.keywords) {
    if (haystack.includes(keyword)) return true;
  }
  return false;
}

export async function throttleMirrorSend(intervalMs: number): Promise<void> {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  await sleep(intervalMs);
}

type TaskRunnerSettings = {
  concurrentMirrors: number;
};

const loadTaskRunnerSettings = createCachedLoader<TaskRunnerSettings>(
  SETTINGS_CACHE_MS,
  async () => {
    const keys = ["concurrent_mirrors"] as const;
    const rows = await loadSettingsRows(keys, "load task runner settings");
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const concurrentMirrorsRaw = parseSettingValue("concurrent_mirrors", map.get("concurrent_mirrors"));
    const concurrentMirrors = Math.min(10, Math.max(1, Math.floor(concurrentMirrorsRaw)));

    return { concurrentMirrors };
  },
  (error: unknown, cached: TaskRunnerSettings | null) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to load task runner settings; using defaults: ${msg}`);
    return cached ?? { concurrentMirrors: schema.defaultSettings.concurrent_mirrors };
  },
);

export async function getTaskRunnerSettings(): Promise<TaskRunnerSettings> {
  return await loadTaskRunnerSettings();
}

type RetryBehaviorSettings = {
  maxRetryCount: number;
  retryIntervalSec: number;
  skipAfterMaxRetry: boolean;
};

const loadRetryBehaviorSettings = createCachedLoader<RetryBehaviorSettings>(
  SETTINGS_CACHE_MS,
  async () => {
    const keys = ["max_retry_count", "retry_interval_sec", "skip_after_max_retry"] as const;
    const rows = await loadSettingsRows(keys, "load retry behavior settings");
    const map = new Map(rows.map((r) => [r.key, r.value]));

    const maxRetryCountRaw = parseSettingValue("max_retry_count", map.get("max_retry_count"));
    const maxRetryCount = Math.min(100, Math.max(0, Math.floor(maxRetryCountRaw)));

    const retryIntervalSecRaw = parseSettingValue("retry_interval_sec", map.get("retry_interval_sec"));
    const retryIntervalSec = Math.min(86_400, Math.max(0, Math.floor(retryIntervalSecRaw)));

    const skipAfterMaxRetry = parseSettingValue("skip_after_max_retry", map.get("skip_after_max_retry"));

    return { maxRetryCount, retryIntervalSec, skipAfterMaxRetry };
  },
  (error: unknown, cached: RetryBehaviorSettings | null) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to load retry behavior settings; using defaults: ${msg}`);
    return (
      cached ?? {
        maxRetryCount: schema.defaultSettings.max_retry_count,
        retryIntervalSec: schema.defaultSettings.retry_interval_sec,
        skipAfterMaxRetry: schema.defaultSettings.skip_after_max_retry === true,
      }
    );
  },
);

export async function getRetryBehaviorSettings(): Promise<RetryBehaviorSettings> {
  return await loadRetryBehaviorSettings();
}

type AutoChannelSettings = {
  prefix: string;
  privateChannel: boolean;
  admins: string[];
};

export function normalizeUserIdentifier(input: string): string {
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

export async function getAutoChannelSettings(): Promise<AutoChannelSettings> {
  const keys = ["auto_channel_prefix", "auto_channel_private", "auto_channel_admins"] as const;

  let rows: { key: string; value: unknown }[] = [];
  try {
    rows = await withDbRetry(
      () =>
        db
          .select({ key: schema.settings.key, value: schema.settings.value })
          .from(schema.settings)
          .where(inArray(schema.settings.key, keys as unknown as string[])),
      "load auto channel settings",
      { attempts: 3, baseDelayMs: 250 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to load auto channel settings; using defaults: ${msg}`);
    return {
      prefix: schema.defaultSettings.auto_channel_prefix,
      privateChannel: schema.defaultSettings.auto_channel_private === true,
      admins: parseUserIdentifierList(schema.defaultSettings.auto_channel_admins),
    };
  }

  const map = new Map(rows.map((r) => [r.key, r.value]));

  const prefixRaw = parseSettingValue("auto_channel_prefix", map.get("auto_channel_prefix"));
  const prefix = prefixRaw.trim() ? prefixRaw : schema.defaultSettings.auto_channel_prefix;
  const privateChannel = parseSettingValue("auto_channel_private", map.get("auto_channel_private"));

  const adminsRaw = parseSettingValue("auto_channel_admins", map.get("auto_channel_admins"));
  const admins = parseUserIdentifierList(adminsRaw);

  return { prefix, privateChannel, admins };
}
