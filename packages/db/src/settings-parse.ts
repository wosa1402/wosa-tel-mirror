import { z } from "zod";
import { defaultSettings } from "./schema/settings";

const mirrorModeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(["forward", "copy"]),
);

const booleanSchema = z.preprocess((value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return false;
    if (value === 1) return true;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y") return true;
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "n") return false;
  }
  return value;
}, z.boolean());

const numberSchema = z.preprocess((value) => {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return value;
    return Number(trimmed);
  }
  return value;
}, z.number().refine((n) => Number.isFinite(n), "必须是有限数字"));

export const appSettingsSchema = z.object({
  telegram_session: z.string().catch(defaultSettings.telegram_session),
  default_mirror_mode: mirrorModeSchema.catch(defaultSettings.default_mirror_mode === "copy" ? "copy" : "forward"),
  concurrent_mirrors: numberSchema.catch(defaultSettings.concurrent_mirrors),
  mirror_interval_ms: numberSchema.catch(defaultSettings.mirror_interval_ms),

  auto_channel_prefix: z.string().catch(defaultSettings.auto_channel_prefix),
  auto_channel_private: booleanSchema.catch(defaultSettings.auto_channel_private),
  auto_channel_admins: z.string().catch(defaultSettings.auto_channel_admins),

  max_retry_count: numberSchema.catch(defaultSettings.max_retry_count),
  retry_interval_sec: numberSchema.catch(defaultSettings.retry_interval_sec),
  skip_after_max_retry: booleanSchema.catch(defaultSettings.skip_after_max_retry),

  sync_message_edits: booleanSchema.catch(defaultSettings.sync_message_edits),
  keep_edit_history: booleanSchema.catch(defaultSettings.keep_edit_history),
  sync_message_deletions: booleanSchema.catch(defaultSettings.sync_message_deletions),

  mirror_videos: booleanSchema.catch(defaultSettings.mirror_videos),
  max_file_size_mb: numberSchema.catch(defaultSettings.max_file_size_mb),
  skip_protected_content: booleanSchema.catch(defaultSettings.skip_protected_content),
  group_media_messages: booleanSchema.catch(defaultSettings.group_media_messages),
  media_group_buffer_ms: numberSchema.catch(defaultSettings.media_group_buffer_ms),

  message_filter_enabled: booleanSchema.catch(defaultSettings.message_filter_enabled),
  message_filter_keywords: z.string().catch(defaultSettings.message_filter_keywords),

  access_password: z.string().catch(defaultSettings.access_password),
});

export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingKey = keyof AppSettings;

export function parseSettingValue<K extends AppSettingKey>(key: K, raw: unknown): AppSettings[K] {
  const fieldSchema = appSettingsSchema.shape[key] as unknown as z.ZodType<AppSettings[K]>;
  return fieldSchema.parse(raw);
}

export function parseSettingsRows(rows: Array<{ key: string; value: unknown }>): AppSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const out: Partial<AppSettings> = {};

  for (const key of Object.keys(defaultSettings) as AppSettingKey[]) {
    (out as Record<string, unknown>)[key] = parseSettingValue(key, map.get(key as string));
  }

  return out as AppSettings;
}
