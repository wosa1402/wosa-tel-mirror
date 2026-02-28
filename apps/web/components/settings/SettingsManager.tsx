"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { getErrorMessage } from "@/lib/utils";

type MirrorMode = "forward" | "copy";

type Settings = {
  default_mirror_mode: MirrorMode;
  concurrent_mirrors: number;
  mirror_interval_ms: number;

  auto_channel_prefix: string;
  auto_channel_private: boolean;
  auto_channel_admins: string;

  max_retry_count: number;
  retry_interval_sec: number;
  skip_after_max_retry: boolean;

  sync_message_edits: boolean;
  keep_edit_history: boolean;
  sync_message_deletions: boolean;

  mirror_videos: boolean;
  max_file_size_mb: number;
  skip_protected_content: boolean;
  group_media_messages: boolean;
  media_group_buffer_ms: number;

  message_filter_enabled: boolean;
  message_filter_keywords: string;
};

const DEFAULTS: Settings = {
  default_mirror_mode: "forward",
  concurrent_mirrors: 1,
  mirror_interval_ms: 1000,
  auto_channel_prefix: "[备份] ",
  auto_channel_private: true,
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
  media_group_buffer_ms: 1500,
  message_filter_enabled: false,
  message_filter_keywords: "",
};

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function toNum(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function toStr(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  return String(value);
}

function toMirrorMode(value: unknown, fallback: MirrorMode): MirrorMode {
  return value === "forward" || value === "copy" ? value : fallback;
}

function parseSettings(value: unknown): Settings {
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    default_mirror_mode: toMirrorMode(obj.default_mirror_mode, DEFAULTS.default_mirror_mode),
    concurrent_mirrors: Math.max(1, Math.floor(toNum(obj.concurrent_mirrors, DEFAULTS.concurrent_mirrors))),
    mirror_interval_ms: Math.max(0, Math.floor(toNum(obj.mirror_interval_ms, DEFAULTS.mirror_interval_ms))),
    auto_channel_prefix: toStr(obj.auto_channel_prefix, DEFAULTS.auto_channel_prefix),
    auto_channel_private: toBool(obj.auto_channel_private, DEFAULTS.auto_channel_private),
    auto_channel_admins: toStr(obj.auto_channel_admins, DEFAULTS.auto_channel_admins),
    max_retry_count: Math.max(0, Math.floor(toNum(obj.max_retry_count, DEFAULTS.max_retry_count))),
    retry_interval_sec: Math.max(0, Math.floor(toNum(obj.retry_interval_sec, DEFAULTS.retry_interval_sec))),
    skip_after_max_retry: toBool(obj.skip_after_max_retry, DEFAULTS.skip_after_max_retry),
    sync_message_edits: toBool(obj.sync_message_edits, DEFAULTS.sync_message_edits),
    keep_edit_history: toBool(obj.keep_edit_history, DEFAULTS.keep_edit_history),
    sync_message_deletions: toBool(obj.sync_message_deletions, DEFAULTS.sync_message_deletions),
    mirror_videos: toBool(obj.mirror_videos, DEFAULTS.mirror_videos),
    max_file_size_mb: Math.max(0, Math.floor(toNum(obj.max_file_size_mb, DEFAULTS.max_file_size_mb))),
    skip_protected_content: toBool(obj.skip_protected_content, DEFAULTS.skip_protected_content),
    group_media_messages: toBool(obj.group_media_messages, DEFAULTS.group_media_messages),
    media_group_buffer_ms: Math.min(
      10_000,
      Math.max(200, Math.floor(toNum(obj.media_group_buffer_ms, DEFAULTS.media_group_buffer_ms))),
    ),
    message_filter_enabled: toBool(obj.message_filter_enabled, DEFAULTS.message_filter_enabled),
    message_filter_keywords: toStr(obj.message_filter_keywords, DEFAULTS.message_filter_keywords),
  };
}

export function SettingsManager() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [telegramSessionSet, setTelegramSessionSet] = useState<boolean | null>(null);
  const [accessPasswordSet, setAccessPasswordSet] = useState<boolean | null>(null);
  const [accessPasswordDraft, setAccessPasswordDraft] = useState("");
  const [presetsImporting, setPresetsImporting] = useState(false);
  const [presetsImportFileName, setPresetsImportFileName] = useState("");
  const [presetsImportText, setPresetsImportText] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load settings");
      setSettings(parseSettings(data.settings));
      setTelegramSessionSet(!!data.telegramSessionSet);
      setAccessPasswordSet(data.accessPasswordSet == null ? null : !!data.accessPasswordSet);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: settings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save settings");
      setSettings(parseSettings(data.settings));
      setTelegramSessionSet(!!data.telegramSessionSet);
      setAccessPasswordSet(data.accessPasswordSet == null ? null : !!data.accessPasswordSet);
      setNotice("已保存");
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const logoutTelegram = async () => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/telegram/logout", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Logout failed");
      await refresh();
      setNotice("已清除 Telegram session（需要重新登录）");
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const saveDisabled = useMemo(() => loading || saving || presetsImporting, [loading, saving, presetsImporting]);
  const canUpdateAccessPassword = useMemo(() => !!accessPasswordDraft.trim() && !saveDisabled, [accessPasswordDraft, saveDisabled]);

  const importPresets = async (mode: "merge" | "replace") => {
    const raw = presetsImportText.trim();
    if (!raw) return;
    if (
      !confirm(
        mode === "replace"
          ? "确认覆盖导入吗？这会用导入文件的预设替换当前预设。"
          : "确认合并导入吗？这会把导入文件的预设合并到当前预设里。",
      )
    ) {
      return;
    }
    setPresetsImporting(true);
    setError("");
    setNotice("");
    try {
      const parsed = JSON.parse(raw) as unknown;
      const obj =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : ({} as Record<string, unknown>);
      const presetsByScope = (obj.presetsByScope ?? obj.presets ?? obj.data ?? obj) as unknown;

      const res = await fetch("/api/presets/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, presetsByScope }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? "导入失败");
      setNotice(mode === "replace" ? "已覆盖导入预设" : "已合并导入预设");
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setPresetsImporting(false);
    }
  };

  const loadPresetsFile = async (file: File | null) => {
    if (!file) {
      setPresetsImportFileName("");
      setPresetsImportText("");
      return;
    }
    setPresetsImportFileName(file.name);
    setError("");
    try {
      const text = await file.text();
      setPresetsImportText(text);
      setNotice(`已选择预设文件：${file.name}`);
    } catch (e: unknown) {
      setPresetsImportText("");
      setError(getErrorMessage(e));
    }
  };

  const updateAccessPassword = async () => {
    const next = accessPasswordDraft.trim();
    if (!next) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: { access_password: next } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update access password");
      setSettings(parseSettings(data.settings));
      setTelegramSessionSet(!!data.telegramSessionSet);
      setAccessPasswordSet(data.accessPasswordSet == null ? null : !!data.accessPasswordSet);
      setAccessPasswordDraft("");
      if (data.requireReauth) {
        setNotice("访问密码已更新，需要重新输入密码");
        setTimeout(() => window.location.reload(), 200);
      } else {
        setNotice("访问密码已更新");
      }
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const disableAccessPassword = async () => {
    if (!confirm("确认禁用访问密码吗？禁用后将不再需要输入访问密码。")) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: { access_password: "" } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to disable access password");
      setSettings(parseSettings(data.settings));
      setTelegramSessionSet(!!data.telegramSessionSet);
      setAccessPasswordSet(data.accessPasswordSet == null ? null : !!data.accessPasswordSet);
      setAccessPasswordDraft("");
      setNotice("访问密码已禁用");
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {error ? (
        <div className="ui-alert-error">{error}</div>
      ) : null}
      {notice ? (
        <div className="ui-alert-info">{notice}</div>
      ) : null}

      <div className="ui-card">
        <h2 className="ui-section-title">Telegram Session</h2>
        <div className="mt-3 text-sm text-gray-700 dark:text-slate-300">
          状态：{telegramSessionSet == null ? "-" : telegramSessionSet ? "已设置" : "未设置"}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href="/"
            className="ui-btn ui-btn-secondary h-10"
          >
            去首页登录
          </Link>
          <button
            type="button"
            onClick={logoutTelegram}
            disabled={saveDisabled || !telegramSessionSet}
            className="ui-btn ui-btn-secondary h-10"
          >
            清除 session
          </button>
        </div>
      </div>

      <div className="ui-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="ui-section-title">同步策略</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">部分配置会影响新建频道的默认行为。</p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => refresh()}
              disabled={saveDisabled}
              className="ui-btn ui-btn-secondary h-10"
            >
              刷新
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saveDisabled}
              className="ui-btn ui-btn-primary h-10"
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>

        <div className="mt-6 space-y-6">
          <div>
            <h3 className="text-sm font-semibold">镜像方式</h3>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium">默认镜像方式（新频道默认）</label>
                <div className="mt-1">
                  <Select
                    value={settings.default_mirror_mode}
                    onChange={(value) => update("default_mirror_mode", value as MirrorMode)}
                    options={[
                      { value: "forward", label: "forward（无署名转发，支持媒体/相册）" },
                      { value: "copy", label: "copy（仅文本，用于测试）" },
                    ]}
                  />
                </div>
              </div>
              <div className="flex flex-col justify-end gap-3">
                <Checkbox
                  label="合并媒体组（相册尽量保持为一组）"
                  checked={settings.group_media_messages}
                  onChange={(checked) => update("group_media_messages", checked)}
                />
                <div>
                  <label className="block text-sm font-medium">相册缓冲时间</label>
                  <div className="mt-1">
                    <Select
                      value={String(settings.media_group_buffer_ms)}
                      onChange={(value) => update("media_group_buffer_ms", Number.parseInt(value, 10))}
                      disabled={!settings.group_media_messages}
                      options={[
                        { value: "900", label: "0.9 秒（更快，但容易拆分）" },
                        { value: "1500", label: "1.5 秒（推荐）" },
                        { value: "2000", label: "2 秒" },
                        { value: "3000", label: "3 秒（更稳，但更慢）" },
                        { value: "5000", label: "5 秒（最稳，但更慢）" },
                      ]}
                    />
                  </div>
                  <p className="mt-1 text-xs text-gray-600 dark:text-slate-400">
                    只在“合并媒体组”开启时生效：时间越长越不容易把同一相册拆开，但发送会稍微延后。
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-3">
              <Checkbox
                label="跳过禁止转发的频道消息（protected content）"
                checked={settings.skip_protected_content}
                onChange={(checked) => update("skip_protected_content", checked)}
              />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold">媒体限制</h3>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium">最大文件大小（MB）</label>
                <input
                  type="number"
                  value={settings.max_file_size_mb}
                  onChange={(e) => update("max_file_size_mb", Number.parseInt(e.target.value, 10) || 0)}
                  className="ui-input mt-1"
                />
              </div>
              <div className="flex items-end">
                <Checkbox label="同步视频" checked={settings.mirror_videos} onChange={(checked) => update("mirror_videos", checked)} />
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold">重试与节流</h3>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium">最大重试次数</label>
                <input
                  type="number"
                  value={settings.max_retry_count}
                  onChange={(e) => update("max_retry_count", Number.parseInt(e.target.value, 10) || 0)}
                  className="ui-input mt-1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium">重试间隔（秒）</label>
                <input
                  type="number"
                  value={settings.retry_interval_sec}
                  onChange={(e) => update("retry_interval_sec", Number.parseInt(e.target.value, 10) || 0)}
                  className="ui-input mt-1"
                />
              </div>
              <div className="flex items-end">
                <Checkbox
                  label="超过最大重试后跳过"
                  checked={settings.skip_after_max_retry}
                  onChange={(checked) => update("skip_after_max_retry", checked)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium">基础间隔（ms）</label>
                <input
                  type="number"
                  value={settings.mirror_interval_ms}
                  onChange={(e) => update("mirror_interval_ms", Number.parseInt(e.target.value, 10) || 0)}
                  className="ui-input mt-1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium">并发（预留）</label>
                <input
                  type="number"
                  value={settings.concurrent_mirrors}
                  onChange={(e) => update("concurrent_mirrors", Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
                  className="ui-input mt-1"
                />
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold">镜像频道（预留）</h3>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="block text-sm font-medium">自动频道前缀</label>
                <input
                  value={settings.auto_channel_prefix}
                  onChange={(e) => update("auto_channel_prefix", e.target.value)}
                  className="ui-input mt-1"
                />
              </div>
              <div className="flex items-end">
                <Checkbox
                  label="自动创建频道为私有"
                  checked={settings.auto_channel_private}
                  onChange={(checked) => update("auto_channel_private", checked)}
                />
              </div>
            </div>
            <div className="mt-3">
              <label className="block text-sm font-medium">自动创建频道后，自动添加管理员（可选）</label>
              <input
                value={settings.auto_channel_admins}
                onChange={(e) => update("auto_channel_admins", e.target.value)}
                placeholder="@username 或 用户id，多个用空格/逗号分隔"
                className="ui-input mt-1"
              />
              <div className="mt-2 text-xs text-black/50 dark:text-slate-400">
                说明：只对“自动创建的镜像频道/评论群”生效。保存后，新创建的频道会尝试邀请这些用户，并授予管理员全部权限（包含“任命管理员”）。
                如果对方开启了隐私限制（不允许被拉进频道/群），Telegram 可能会拒绝，此时会在“事件中心”里看到提示。
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold">编辑/删除（仅记录到数据库）</h3>
            <p className="mt-1 text-xs text-black/50 dark:text-slate-400">开启后会记录源消息的编辑/撤回标记用于 Web 展示，不会修改镜像频道的备份消息。</p>
            <div className="mt-3 flex flex-col gap-2 text-sm">
              <Checkbox
                label="同步编辑"
                checked={settings.sync_message_edits}
                onChange={(checked) => update("sync_message_edits", checked)}
              />
              <Checkbox
                label="保留编辑历史"
                checked={settings.keep_edit_history}
                onChange={(checked) => update("keep_edit_history", checked)}
              />
              <Checkbox
                label="同步删除"
                checked={settings.sync_message_deletions}
                onChange={(checked) => update("sync_message_deletions", checked)}
              />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold">广告/垃圾消息过滤（可选）</h3>
            <p className="mt-1 text-xs text-black/50 dark:text-slate-400">
              命中关键词的消息会被“跳过”，不会发送到镜像频道；在 Messages 里会显示为 skipped（filtered）。
            </p>
            <p className="mt-1 text-xs text-black/50 dark:text-slate-400">
              提示：如果你只想对某个频道生效/或想对某个频道单独配置，请去该频道的详情页设置“广告过滤（该频道）”。
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="flex items-end">
                <Checkbox
                  label="启用过滤"
                  checked={settings.message_filter_enabled}
                  onChange={(checked) => update("message_filter_enabled", checked)}
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium">关键词列表</label>
                <textarea
                  value={settings.message_filter_keywords}
                  onChange={(e) => update("message_filter_keywords", e.target.value)}
                  rows={4}
                  placeholder={"每行一个关键词（也支持空格/逗号分隔）\n例如：\n广告\n加群\nVX"}
                  className="ui-textarea mt-1"
                />
                <div className="mt-2 text-xs text-black/50 dark:text-slate-400">留空=不过滤；建议先放少量关键词，观察效果后再加。</div>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold">访问控制</h3>
            <div className="mt-3">
              <div className="text-sm text-black/70 dark:text-slate-300">
                状态：{accessPasswordSet == null ? "-" : accessPasswordSet ? "已启用" : "未启用"}
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium">设置/更新访问密码</label>
                  <input
                    type="password"
                    value={accessPasswordDraft}
                    onChange={(e) => setAccessPasswordDraft(e.target.value)}
                    placeholder="留空表示不修改"
                    className="ui-input mt-1"
                  />
                </div>
                <div className="flex items-end gap-2">
                  <button
                    type="button"
                    onClick={updateAccessPassword}
                    disabled={!canUpdateAccessPassword}
                    className="ui-btn ui-btn-secondary h-10 px-4 text-sm"
                  >
                    更新密码
                  </button>
                  <button
                    type="button"
                    onClick={disableAccessPassword}
                    disabled={saveDisabled || !accessPasswordSet}
                    className="inline-flex h-10 items-center justify-center rounded-md border border-red-200 bg-red-50 px-4 text-sm text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/15"
                  >
                    禁用
                  </button>
                </div>
              </div>
              <div className="mt-2 text-xs text-black/50 dark:text-slate-400">启用后会强制校验访问密码（所有页面/API）。</div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold">预设备份/恢复（可选）</h3>
            <p className="mt-1 text-xs text-black/50 dark:text-slate-400">只备份/恢复你在各页面保存的“筛选预设”（不包含 Telegram session/访问密码）。</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href="/api/export/presets"
                className="ui-btn ui-btn-secondary h-10 px-4 text-sm"
              >
                导出我的筛选预设（JSON）
              </a>
            </div>

            <div className="mt-3 rounded-md border border-black/10 bg-white p-3 dark:border-white/10 dark:bg-slate-900/40">
              <div className="text-sm font-medium">导入预设文件</div>
              <div className="mt-2 flex flex-col gap-3 md:flex-row md:items-end">
                <div className="flex-1">
                  <input
                    type="file"
                    accept="application/json"
                    disabled={saveDisabled}
                    onChange={(e) => loadPresetsFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm dark:text-slate-200"
                  />
                  <div className="mt-2 text-xs text-black/50 dark:text-slate-400">
                    {presetsImportFileName ? `已选择：${presetsImportFileName}` : "未选择文件"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => importPresets("merge")}
                    disabled={saveDisabled || !presetsImportText.trim()}
                    className="ui-btn ui-btn-secondary h-10 px-4 text-sm"
                  >
                    合并导入
                  </button>
                  <button
                    type="button"
                    onClick={() => importPresets("replace")}
                    disabled={saveDisabled || !presetsImportText.trim()}
                    className="inline-flex h-10 items-center justify-center rounded-md border border-red-200 bg-red-50 px-4 text-sm text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/15"
                  >
                    覆盖导入
                  </button>
                </div>
              </div>
              <div className="mt-2 text-xs text-black/50 dark:text-slate-400">
                建议优先用“合并导入”。只有在你想把现有预设全部清空并换成导入文件时，才用“覆盖导入”。
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
