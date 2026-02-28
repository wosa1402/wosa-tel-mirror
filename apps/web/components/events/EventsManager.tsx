"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { AlertCircle, Clock, Info, XCircle } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { type LocalQueryPreset } from "@/lib/local-presets";
import { deleteQueryPreset, loadQueryPresets, saveQueryPreset } from "@/lib/query-presets";
import { formatTime, getErrorMessage } from "@/lib/utils";

type EventLevel = "info" | "warn" | "error";

const UNGROUPED = "__ungrouped__";
const PRESETS_STORAGE_KEY = "tg-back:presets:events";

type EventRow = {
  id: string;
  sourceChannelId: string | null;
  level: EventLevel;
  message: string;
  createdAt: string;
  source:
    | {
        id: string;
        name: string;
        channelIdentifier: string;
        username: string | null;
      }
    | null;
};

type ChannelOption = {
  id: string;
  name: string;
  channelIdentifier: string;
  groupName: string;
};

const iconMap: Record<EventLevel, typeof Info> = {
  info: Info,
  warn: AlertCircle,
  error: XCircle,
};

const colorMap: Record<EventLevel, { bg: string; text: string; icon: string; border: string }> = {
  info: {
    bg: "bg-blue-100 dark:bg-blue-500/15",
    text: "text-blue-700 dark:text-blue-200",
    icon: "text-blue-600 dark:text-blue-300",
    border: "border-blue-200 dark:border-blue-500/30",
  },
  warn: {
    bg: "bg-orange-100 dark:bg-orange-500/15",
    text: "text-orange-700 dark:text-orange-200",
    icon: "text-orange-600 dark:text-orange-300",
    border: "border-orange-200 dark:border-orange-500/30",
  },
  error: {
    bg: "bg-red-100 dark:bg-red-500/15",
    text: "text-red-700 dark:text-red-200",
    icon: "text-red-600 dark:text-red-300",
    border: "border-red-200 dark:border-red-500/30",
  },
};

export function EventsManager({
  initialGroupName = "",
  initialSourceChannelId = "",
  initialLevel = "",
  initialQuery = "",
  initialLimit = 50,
}: {
  initialGroupName?: string;
  initialSourceChannelId?: string;
  initialLevel?: string;
  initialQuery?: string;
  initialLimit?: number;
}) {
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [events, setEvents] = useState<EventRow[]>([]);

  const [groupFilter, setGroupFilter] = useState(initialGroupName);
  const [selectedChannelId, setSelectedChannelId] = useState(initialSourceChannelId);
  const [level, setLevel] = useState(initialLevel);
  const [q, setQ] = useState(initialQuery);
  const [limit, setLimit] = useState(initialLimit);

  const [savedPresets, setSavedPresets] = useState<LocalQueryPreset[]>([]);

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoRefreshMs, setAutoRefreshMs] = useState(5000);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTimerRef = useRef<number | null>(null);

  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const loadingRef = useRef(false);
  const refreshingRef = useRef(false);

  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(""), 3000);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const presets = await loadQueryPresets({ scope: "events", storageKey: PRESETS_STORAGE_KEY });
      if (!cancelled) setSavedPresets(presets);
    })();
    return () => {
      cancelled = true;
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const loadChannels = async (): Promise<void> => {
    setChannelsLoading(true);
    try {
      const res = await fetch("/api/channels?mode=options", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to load channels");
      const rows = (data.channels ?? []) as Array<{ id: string; name: string; channelIdentifier: string; groupName?: string }>;
      setChannels(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          channelIdentifier: r.channelIdentifier,
          groupName: typeof r.groupName === "string" ? r.groupName : "",
        })),
      );
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setChannelsLoading(false);
    }
  };

  const groupOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of channels) {
      const g = (c.groupName ?? "").trim();
      if (g) set.add(g);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [channels]);

  const hasUngrouped = useMemo(() => channels.some((c) => !(c.groupName ?? "").trim()), [channels]);

  const visibleChannels = useMemo(() => {
    const g = groupFilter.trim();
    if (!g) return channels;
    if (g === UNGROUPED) return channels.filter((c) => !(c.groupName ?? "").trim());
    return channels.filter((c) => (c.groupName ?? "").trim() === g);
  }, [channels, groupFilter]);

  const buildQuery = (
    overrides: Partial<{
      groupFilter: string;
      selectedChannelId: string;
      level: string;
      q: string;
      limit: number;
    }> = {},
  ): string => {
    const groupFilterEffective = overrides.groupFilter ?? groupFilter;
    const selectedChannelIdEffective = overrides.selectedChannelId ?? selectedChannelId;
    const levelEffective = overrides.level ?? level;
    const qEffective = overrides.q ?? q;
    const limitEffective = overrides.limit ?? limit;

    const params = new URLSearchParams();
    if (selectedChannelIdEffective) params.set("sourceChannelId", selectedChannelIdEffective);
    else if (groupFilterEffective === UNGROUPED) params.set("groupName", "");
    else if (groupFilterEffective.trim()) params.set("groupName", groupFilterEffective.trim());
    if (levelEffective) params.set("level", levelEffective);
    if (qEffective.trim()) params.set("q", qEffective.trim());
    params.set("limit", String(limitEffective));
    return params.toString();
  };

  const buildShareUrl = (overrides?: Parameters<typeof buildQuery>[0]): string => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    const query = buildQuery(overrides);
    url.search = query ? `?${query}` : "";
    return url.toString();
  };

  const syncUrlToCurrentQuery = (overrides?: Parameters<typeof buildQuery>[0]) => {
    const nextUrl = buildShareUrl(overrides);
    if (!nextUrl) return;
    window.history.replaceState(null, "", nextUrl);
  };

  const copyQueryLink = async () => {
    const url = buildShareUrl();
    if (!url) return;
    syncUrlToCurrentQuery();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        showNotice("已复制查询链接");
        return;
      }
      throw new Error("clipboard not available");
    } catch {
      window.prompt("复制下面这个链接（手动复制）：", url);
    }
  };

  const refresh = async (overrides?: Parameters<typeof buildQuery>[0]): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/events?${buildQuery(overrides)}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = [json.error, json.cause].filter(Boolean).join("\n");
        throw new Error(details || "Failed to load events");
      }
      setEvents((json.events ?? []) as EventRow[]);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const refreshSilently = async (overrides?: Parameters<typeof buildQuery>[0]): Promise<void> => {
    setRefreshing(true);
    setError("");
    try {
      const res = await fetch(`/api/events?${buildQuery(overrides)}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = [json.error, json.cause].filter(Boolean).join("\n");
        throw new Error(details || "Failed to load events");
      }
      setEvents((json.events ?? []) as EventRow[]);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };

  const applyPreset = (overrides: NonNullable<Parameters<typeof buildQuery>[0]> = {}) => {
    setNotice("");
    syncUrlToCurrentQuery(overrides);
    void refresh(overrides);

    if (typeof overrides.groupFilter !== "undefined") setGroupFilter(overrides.groupFilter);
    if (typeof overrides.selectedChannelId !== "undefined") setSelectedChannelId(overrides.selectedChannelId);
    if (typeof overrides.level !== "undefined") setLevel(overrides.level);
    if (typeof overrides.q !== "undefined") setQ(overrides.q);
    if (typeof overrides.limit !== "undefined") setLimit(overrides.limit);
  };

  const saveCurrentAsPreset = async () => {
    const currentQuery = buildQuery();
    const channelName = selectedChannelId ? channels.find((c) => c.id === selectedChannelId)?.name ?? "" : "";
    const groupLabel = groupFilter === UNGROUPED ? "未分组" : groupFilter.trim();
    const parts: string[] = [];
    if (channelName) parts.push(channelName);
    else if (groupLabel) parts.push(`分组:${groupLabel}`);
    else parts.push("全部频道");
    if (level) parts.push(level);
    if (q.trim()) parts.push(`关键词:${q.trim().slice(0, 12)}`);
    const suggested = parts.join(" ");

    const name = window.prompt("给这个预设起个名字：", suggested)?.trim() ?? "";
    if (!name) return;

    const next = await saveQueryPreset({ scope: "events", name, query: currentQuery, storageKey: PRESETS_STORAGE_KEY });
    setSavedPresets(next);
    showNotice("已保存预设");
  };

  const deletePreset = async (id: string) => {
    const next = await deleteQueryPreset({ scope: "events", id, storageKey: PRESETS_STORAGE_KEY });
    setSavedPresets(next);
    showNotice("已删除预设");
  };

  const applyPresetQueryString = (query: string) => {
    const params = new URLSearchParams(query);
    const nextSelectedChannelId = params.get("sourceChannelId")?.trim() ?? "";
    const hasGroupParam = params.has("groupName") || params.has("group_name");
    const groupRaw = (params.get("groupName") ?? params.get("group_name") ?? "").trim();
    const nextGroupFilter = nextSelectedChannelId ? "" : hasGroupParam ? (groupRaw ? groupRaw : UNGROUPED) : "";

    const nextLevel = params.get("level")?.trim() ?? "";
    const nextQ = params.get("q")?.trim() ?? "";
    const limitRaw = params.get("limit")?.trim() ?? "";
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
    const nextLimit = Number.isFinite(parsedLimit) ? Math.min(500, Math.max(1, Math.trunc(parsedLimit))) : 50;

    applyPreset({
      groupFilter: nextGroupFilter,
      selectedChannelId: nextSelectedChannelId,
      level: nextLevel,
      q: nextQ,
      limit: nextLimit,
    });
  };

  refreshRef.current = refreshSilently;
  loadingRef.current = loading;
  refreshingRef.current = refreshing;

  useEffect(() => {
    loadChannels().catch(() => {});
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (loadingRef.current || refreshingRef.current) return;
      void refreshRef.current().catch(() => {});
    }, autoRefreshMs);
    return () => window.clearInterval(id);
  }, [autoRefresh, autoRefreshMs]);

  const channelLabel = useMemo(() => {
    if (!selectedChannelId) {
      if (groupFilter === UNGROUPED) return "分组：未分组（全部频道）";
      if (groupFilter.trim()) return `分组：${groupFilter.trim()}（全部频道）`;
      return "全部频道";
    }
    const found = channels.find((c) => c.id === selectedChannelId);
    if (!found) return selectedChannelId;
    return `${found.name} (${found.channelIdentifier})`;
  }, [channels, selectedChannelId, groupFilter]);

  return (
    <div className="space-y-6">
      {error ? <div className="ui-alert-error">{error}</div> : null}
      {notice ? <div className="ui-alert-info">{notice}</div> : null}

      <div className="ui-card">
        <h2 className="ui-section-title">筛选</h2>
        <div className="mt-4 grid grid-cols-1 gap-3">
          <div>
            <label className="block text-sm font-medium">分组</label>
            <div className="mt-1">
              <Select
                value={groupFilter}
                onChange={(next) => {
                  setGroupFilter(next);
                  if (!next || !selectedChannelId) return;
                  const found = channels.find((c) => c.id === selectedChannelId);
                  if (!found) {
                    setSelectedChannelId("");
                    return;
                  }
                  const foundGroup = (found.groupName ?? "").trim();
                  if (next === UNGROUPED) {
                    if (foundGroup) setSelectedChannelId("");
                    return;
                  }
                  if (foundGroup !== next) setSelectedChannelId("");
                }}
                options={[
                  { value: "", label: channelsLoading ? "全部分组（加载中...）" : "全部分组" },
                  ...(hasUngrouped ? [{ value: UNGROUPED, label: "未分组" }] : []),
                  ...groupOptions.map((g) => ({ value: g, label: g })),
                ]}
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium">频道</label>
            <div className="mt-1">
              <Select
                value={selectedChannelId}
                onChange={(next) => setSelectedChannelId(next)}
                disabled={!visibleChannels.length}
                options={
                  visibleChannels.length
                    ? [
                        {
                          value: "",
                          label:
                            groupFilter === UNGROUPED ? "未分组全部频道" : groupFilter.trim() ? "该分组全部频道" : "全部频道",
                        },
                        ...visibleChannels.map((c) => ({
                          value: c.id,
                          label: `${c.name} (${c.channelIdentifier})`,
                        })),
                      ]
                    : [{ value: "", label: channelsLoading ? "（加载中...）" : "（暂无频道）" }]
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">级别</label>
              <div className="mt-1">
                <Select
                  value={level}
                  onChange={(next) => setLevel(next)}
                  options={[
                    { value: "", label: "全部" },
                    { value: "info", label: "info" },
                    { value: "warn", label: "warn" },
                    { value: "error", label: "error" },
                  ]}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium">显示数量</label>
              <div className="mt-1">
                <Select
                  value={String(limit)}
                  onChange={(next) => setLimit(Number.parseInt(next, 10))}
                  options={[
                    { value: "50", label: "50" },
                    { value: "100", label: "100" },
                    { value: "200", label: "200" },
                  ]}
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium">关键词（搜索事件内容，空格分隔=同时包含）</label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="例如：healthcheck / protected / ERROR CODE"
              className="ui-input mt-1"
            />
          </div>

          <div className="rounded-md border border-black/10 bg-black/5 p-3 text-sm dark:border-white/10 dark:bg-white/5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">我的预设（保存到服务器）</div>
              <button
                type="button"
                onClick={() => saveCurrentAsPreset()}
                disabled={loading}
                className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                保存当前为预设
              </button>
            </div>

            {savedPresets.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {savedPresets.map((p) => (
                  <div key={p.id} className="inline-flex overflow-hidden rounded-md border border-black/10 bg-white dark:border-white/10 dark:bg-slate-900/40">
                    <button
                      type="button"
                      onClick={() => applyPresetQueryString(p.query)}
                      disabled={loading}
                      className="inline-flex h-8 items-center justify-center px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:text-slate-100 dark:hover:bg-white/10"
                      title={p.query}
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePreset(p.id)}
                      disabled={loading}
                      className="inline-flex h-8 items-center justify-center border-l border-black/10 px-2 text-xs text-black/50 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:text-slate-400 dark:hover:bg-white/10"
                      title="删除这个预设"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-xs text-black/60 dark:text-slate-400">暂无预设：先把筛选条件调好，再点“保存当前为预设”。</div>
            )}

            <div className="mt-3 border-t border-black/10 pt-3 dark:border-white/10">
              <div className="font-medium">内置快捷（点一下就查询）</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => applyPreset({ level: "error" })}
                  disabled={loading}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  仅 error
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset({ level: "warn" })}
                  disabled={loading}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  仅 warn
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset({ level: "info" })}
                  disabled={loading}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  仅 info
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                setNotice("");
                syncUrlToCurrentQuery();
                void refresh();
              }}
              disabled={loading}
              className="ui-btn ui-btn-primary h-10"
            >
              {loading ? "查询中..." : "查询"}
            </button>
            <button
              type="button"
              onClick={() => {
                setNotice("");
                void copyQueryLink();
              }}
              disabled={loading}
              className="ui-btn ui-btn-secondary h-10"
            >
              复制查询链接
            </button>
            <button
              type="button"
              onClick={() => {
                setNotice("");
                syncUrlToCurrentQuery({ selectedChannelId: "", level: "", q: "", limit: 50 });
                setSelectedChannelId("");
                setLevel("");
                setQ("");
                setLimit(50);
                setEvents([]);
              }}
              disabled={loading}
              className="ui-btn ui-btn-secondary h-10"
            >
              清空条件
            </button>
          </div>
        </div>
      </div>

      <div className="ui-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="ui-section-title">事件列表</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
              {channelLabel} · {events.length ? `已加载 ${events.length} 条` : "暂无数据（先点击“查询”）"}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <Checkbox label="自动刷新" checked={autoRefresh} onChange={(checked) => setAutoRefresh(checked)} />
              <div className="w-28">
                <Select
                  value={String(autoRefreshMs)}
                  onChange={(value) => setAutoRefreshMs(Number.parseInt(value, 10))}
                  disabled={!autoRefresh}
                  options={[
                    { value: "1000", label: "1秒" },
                    { value: "2000", label: "2秒" },
                    { value: "5000", label: "5秒" },
                    { value: "10000", label: "10秒" },
                  ]}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => refresh()}
              disabled={loading}
              className="ui-btn ui-btn-secondary h-10"
            >
              {loading ? "刷新中..." : refreshing ? "更新中..." : "刷新"}
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {!events.length ? (
            <div className="text-sm text-gray-600 dark:text-slate-300">{loading ? "加载中..." : "暂无事件"}</div>
          ) : (
            events.map((e) => {
              const Icon = iconMap[e.level];
              const colors = colorMap[e.level];
              const channelText = e.source ? e.source.name : "system";
              const detailFallback = e.source?.channelIdentifier ?? "";
              const lines = e.message.split("\n").filter((line) => line.trim());
              const title = lines[0] ?? "（无消息）";
              const detail = lines.slice(1).join("\n") || detailFallback;
              return (
                <div
                  key={e.id}
                  className={clsx(
                    "glass-panel rounded-2xl p-5 border-l-4",
                    colors.border,
                  )}
                >
                  <div className="flex items-start gap-4">
                    <div
                      className={clsx(
                        "w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0",
                        colors.bg,
                      )}
                    >
                      <Icon className={clsx("w-5 h-5", colors.icon)} />
                    </div>

                    <div className="flex-1 min-w-0 space-y-2">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-gray-900 dark:text-slate-100">{title}</h3>
                          <span
                            className={clsx(
                              "px-2 py-0.5 text-xs rounded-full font-medium",
                              colors.bg,
                              colors.text,
                            )}
                          >
                            {e.level.toUpperCase()}
                          </span>
                        </div>
                        {detail ? <p className="text-sm text-gray-600 dark:text-slate-300 mt-1 whitespace-pre-wrap">{detail}</p> : null}
                      </div>

                      <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-slate-400">
                        <span className="font-medium text-gray-700 dark:text-slate-200">{channelText}</span>
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(e.createdAt)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
