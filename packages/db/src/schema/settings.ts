import { boolean, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>(),
});

export const defaultSettings = {
  telegram_session: "",

  default_mirror_mode: "forward",
  concurrent_mirrors: 1,
  mirror_interval_ms: 1000,

  auto_channel_prefix: "[备份] ",
  auto_channel_private: true,
  // 自动创建频道后，自动邀请并提升为管理员的用户列表（@username 或用户 id，多项用空格/逗号分隔）
  auto_channel_admins: "",

  max_retry_count: 3,
  retry_interval_sec: 60,
  skip_after_max_retry: true,

  sync_message_edits: false,
  keep_edit_history: true,
  sync_message_deletions: false,

  mirror_videos: true,
  max_file_size_mb: 100,
  skip_protected_content: true,
  group_media_messages: true,
  // 相册消息（同 groupedId）在 realtime 里会做一段时间的缓冲收集，避免网络抖动把相册拆成多次发送。
  media_group_buffer_ms: 1500,

  // 广告/垃圾消息过滤：命中关键词的消息会被跳过（不会发送到镜像频道）。
  message_filter_enabled: false,
  // 多个关键词用换行/空格/逗号分隔（建议每行一个，简单好用）。
  message_filter_keywords: "",

  access_password: "",
};
