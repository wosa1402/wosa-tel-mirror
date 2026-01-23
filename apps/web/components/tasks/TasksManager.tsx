"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { CheckCircle, Clock, Pause, Play, RefreshCw } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { type LocalQueryPreset } from "@/lib/local-presets";
import { deleteQueryPreset, loadQueryPresets, saveQueryPreset } from "@/lib/query-presets";

type TaskStatus = "pending" | "running" | "paused" | "completed" | "failed";
type TaskType = "resolve" | "history_full" | "history_partial" | "realtime" | "retry_failed";

const UNGROUPED = "__ungrouped__";
const PRESETS_STORAGE_KEY = "tg-back:presets:tasks";

type ChannelOption = {
  id: string;
  name: string;
  channelIdentifier: string;
  groupName: string;
};

type TaskRow = {
  id: string;
  sourceChannelId: string;
  taskType: TaskType;
  status: TaskStatus;
  progressCurrent: number;
  progressTotal: number | null;
  lastProcessedId: number | null;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  pausedAt: string | null;
  source: {
    id: string;
    name: string;
    channelIdentifier: string;
    username: string | null;
    isActive: boolean;
  };
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatTime(value: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN");
}

function formatProgress(current: number, total: number | null): string {
  if (typeof total === "number" && Number.isFinite(total)) return `${current}/${total}`;
  return String(current);
}

function calcProgressPct(current: number, total: number | null): number | null {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(current) || current <= 0) return 0;
  return Math.max(0, Math.min(100, (current / total) * 100));
}

function labelTaskStatus(status: TaskStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "pending":
      return "队列中";
    case "paused":
      return "暂停";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return status;
  }
}

function taskStatusBadgeClass(status: TaskStatus): string {
  if (status === "running") return "bg-green-100 text-green-700";
  if (status === "pending") return "bg-blue-100 text-blue-700";
  if (status === "failed") return "bg-red-100 text-red-700";
  return "bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-slate-200";
}

function labelTaskType(type: TaskType): string {
  switch (type) {
    case "history_full":
      return "历史同步";
    case "realtime":
      return "实时监听";
    case "retry_failed":
      return "重试失败";
    case "resolve":
      return "解析频道";
    case "history_partial":
      return "历史同步（部分）";
    default:
      return type;
  }
}

function formatClockTime(value: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function parseFloodWaitSecondsFromText(text: string | null): number | null {
  if (!text) return null;
  const m1 = text.match(/FLOOD_WAIT_(\d+)/);
  if (m1) return Number.parseInt(m1[1] ?? "", 10);
  const m2 = text.match(/A wait of (\d+) seconds is required/i);
  if (m2) return Number.parseInt(m2[1] ?? "", 10);
  return null;
}

function formatRemainingTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const sec = Math.max(0, Math.ceil(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.ceil(sec / 60);
  if (min < 60) return `${min}m`;
  const hour = Math.ceil(min / 60);
  return `${hour}h`;
}

function getFloodWaitAutoResumeHint(task: Pick<TaskRow, "status" | "lastError" | "pausedAt">): string | null {
  if (task.status !== "paused") return null;
  if (!task.pausedAt) return null;
  const waitSeconds = parseFloodWaitSecondsFromText(task.lastError);
  if (!waitSeconds || !Number.isFinite(waitSeconds) || waitSeconds <= 0) return null;
  const pausedAtMs = new Date(task.pausedAt).getTime();
  if (!Number.isFinite(pausedAtMs)) return null;
  const resumeAtMs = pausedAtMs + (waitSeconds + 1) * 1000;
  const remainingMs = resumeAtMs - Date.now();
  if (remainingMs <= 0) return "Telegram 限流等待已到，任务会自动继续（稍等片刻或刷新）";
  return `Telegram 限流中，预计 ${formatRemainingTime(remainingMs)} 后自动继续`;
}

function estimateEta(task: Pick<TaskRow, "startedAt" | "progressCurrent" | "progressTotal" | "status">): string | null {
  if (task.status !== "running") return null;
  if (!task.startedAt) return null;
  if (task.progressTotal == null || !Number.isFinite(task.progressTotal) || task.progressTotal <= 0) return null;
  if (!Number.isFinite(task.progressCurrent) || task.progressCurrent <= 0) return null;

  const startTs = new Date(task.startedAt).getTime();
  if (!Number.isFinite(startTs)) return null;
  const elapsedMs = Date.now() - startTs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 15_000) return null;

  const rate = task.progressCurrent / (elapsedMs / 1000);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const remaining = task.progressTotal - task.progressCurrent;
  if (!Number.isFinite(remaining) || remaining <= 0) return "0 分钟";

  const etaSeconds = remaining / rate;
  if (!Number.isFinite(etaSeconds) || etaSeconds <= 0) return null;
  if (etaSeconds < 60) return `${Math.ceil(etaSeconds)} 秒`;
  if (etaSeconds < 3600) return `${Math.ceil(etaSeconds / 60)} 分钟`;
  if (etaSeconds < 86400) return `${Math.ceil(etaSeconds / 3600)} 小时`;
  return `${Math.ceil(etaSeconds / 86400)} 天`;
}

export function TasksManager({
  initialGroupName = "",
  initialSourceChannelId = "",
  initialStatus = "",
  initialTaskType = "",
  initialLimit = 200,
  initialViewMode = "channel",
  initialHideCompleted = true,
}: {
  initialGroupName?: string;
  initialSourceChannelId?: string;
  initialStatus?: string;
  initialTaskType?: string;
  initialLimit?: number;
  initialViewMode?: "channel" | "task";
  initialHideCompleted?: boolean;
}) {
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>([]);

  const [viewMode, setViewMode] = useState<"channel" | "task">(initialViewMode);
  const [hideCompleted, setHideCompleted] = useState(initialHideCompleted);

  const [groupFilter, setGroupFilter] = useState(initialGroupName);
  const [selectedChannelId, setSelectedChannelId] = useState(initialSourceChannelId);
  const [status, setStatus] = useState(initialStatus);
  const [taskType, setTaskType] = useState(initialTaskType);
  const [limit, setLimit] = useState(initialLimit);

  const [savedPresets, setSavedPresets] = useState<LocalQueryPreset[]>([]);

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoRefreshMs, setAutoRefreshMs] = useState(1000);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTimerRef = useRef<number | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const loadingRef = useRef(false);
  const refreshingRef = useRef(false);

  const canRefresh = useMemo(() => !loading && !refreshing, [loading, refreshing]);

  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(""), 3000);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const presets = await loadQueryPresets({ scope: "tasks", storageKey: PRESETS_STORAGE_KEY });
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
      const res = await fetch("/api/channels?mode=options");
      const data = await res.json();
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
      status: string;
      taskType: string;
      limit: number;
    }> = {},
  ): string => {
    const groupFilterEffective = overrides.groupFilter ?? groupFilter;
    const selectedChannelIdEffective = overrides.selectedChannelId ?? selectedChannelId;
    const statusEffective = overrides.status ?? status;
    const taskTypeEffective = overrides.taskType ?? taskType;
    const limitEffective = overrides.limit ?? limit;

    const params = new URLSearchParams();
    if (selectedChannelIdEffective) params.set("sourceChannelId", selectedChannelIdEffective);
    else if (groupFilterEffective === UNGROUPED) params.set("groupName", "");
    else if (groupFilterEffective.trim()) params.set("groupName", groupFilterEffective.trim());
    if (statusEffective) params.set("status", statusEffective);
    if (taskTypeEffective) params.set("taskType", taskTypeEffective);
    params.set("limit", String(limitEffective));
    return params.toString();
  };

  const buildShareQuery = (
    overrides: Partial<{
      groupFilter: string;
      selectedChannelId: string;
      status: string;
      taskType: string;
      limit: number;
      viewMode: "channel" | "task";
      hideCompleted: boolean;
    }> = {},
  ): string => {
    const viewModeEffective = overrides.viewMode ?? viewMode;
    const hideCompletedEffective = overrides.hideCompleted ?? hideCompleted;

    const params = new URLSearchParams(buildQuery(overrides));
    if (viewModeEffective !== "channel") params.set("viewMode", viewModeEffective);
    if (!hideCompletedEffective) params.set("hideCompleted", "false");
    return params.toString();
  };

  const buildShareUrl = (overrides?: Parameters<typeof buildShareQuery>[0]): string => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    const query = buildShareQuery(overrides);
    url.search = query ? `?${query}` : "";
    return url.toString();
  };

  const syncUrlToCurrentQuery = (overrides?: Parameters<typeof buildShareQuery>[0]) => {
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
        showNotice("已复制筛选链接");
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
      const res = await fetch(`/api/tasks?${buildQuery(overrides)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load tasks");
      setTasks((data.tasks ?? []) as TaskRow[]);
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
      const res = await fetch(`/api/tasks?${buildQuery(overrides)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load tasks");
      setTasks((data.tasks ?? []) as TaskRow[]);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };

  const applyPreset = (overrides: NonNullable<Parameters<typeof buildShareQuery>[0]> = {}) => {
    setNotice("");
    syncUrlToCurrentQuery(overrides);
    void refresh(overrides);

    if (typeof overrides.groupFilter !== "undefined") setGroupFilter(overrides.groupFilter);
    if (typeof overrides.selectedChannelId !== "undefined") setSelectedChannelId(overrides.selectedChannelId);
    if (typeof overrides.status !== "undefined") setStatus(overrides.status);
    if (typeof overrides.taskType !== "undefined") setTaskType(overrides.taskType);
    if (typeof overrides.limit !== "undefined") setLimit(overrides.limit);
    if (typeof overrides.viewMode !== "undefined") setViewMode(overrides.viewMode);
    if (typeof overrides.hideCompleted !== "undefined") setHideCompleted(overrides.hideCompleted);
  };

  const saveCurrentAsPreset = async () => {
    const currentQuery = buildShareQuery();
    const channelName = selectedChannelId ? channels.find((c) => c.id === selectedChannelId)?.name ?? "" : "";
    const groupLabel = groupFilter === UNGROUPED ? "未分组" : groupFilter.trim();
    const parts: string[] = [];
    if (channelName) parts.push(channelName);
    else if (groupLabel) parts.push(`分组:${groupLabel}`);
    else parts.push("全部频道");
    if (status) parts.push(status);
    if (taskType) parts.push(taskType);
    const suggested = parts.join(" ");

    const name = window.prompt("给这个预设起个名字：", suggested)?.trim() ?? "";
    if (!name) return;

    const next = await saveQueryPreset({ scope: "tasks", name, query: currentQuery, storageKey: PRESETS_STORAGE_KEY });
    setSavedPresets(next);
    showNotice("已保存预设");
  };

  const deletePreset = async (id: string) => {
    const next = await deleteQueryPreset({ scope: "tasks", id, storageKey: PRESETS_STORAGE_KEY });
    setSavedPresets(next);
    showNotice("已删除预设");
  };

  const applyPresetQueryString = (query: string) => {
    const params = new URLSearchParams(query);
    const nextSelectedChannelId = params.get("sourceChannelId")?.trim() ?? "";
    const hasGroupParam = params.has("groupName") || params.has("group_name");
    const groupRaw = (params.get("groupName") ?? params.get("group_name") ?? "").trim();
    const nextGroupFilter = nextSelectedChannelId ? "" : hasGroupParam ? (groupRaw ? groupRaw : UNGROUPED) : "";

    const nextStatus = params.get("status")?.trim() ?? "";
    const nextTaskType = params.get("taskType")?.trim() ?? "";
    const limitRaw = params.get("limit")?.trim() ?? "";
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
    const nextLimit = Number.isFinite(parsedLimit) ? Math.min(500, Math.max(1, Math.trunc(parsedLimit))) : 200;

    const nextViewMode = params.get("viewMode")?.trim() === "task" ? "task" : "channel";
    const hideCompletedRaw = params.get("hideCompleted")?.trim().toLowerCase() ?? "";
    const nextHideCompleted = hideCompletedRaw ? !(hideCompletedRaw === "0" || hideCompletedRaw === "false") : true;

    applyPreset({
      groupFilter: nextGroupFilter,
      selectedChannelId: nextSelectedChannelId,
      status: nextStatus,
      taskType: nextTaskType,
      limit: nextLimit,
      viewMode: nextViewMode,
      hideCompleted: nextHideCompleted,
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

    if (typeof EventSource === "undefined") {
      const id = window.setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        if (loadingRef.current || refreshingRef.current) return;
        void refreshRef.current().catch(() => {});
      }, autoRefreshMs);
      return () => window.clearInterval(id);
    }

    const params = new URLSearchParams(buildQuery());
    params.set("intervalMs", String(autoRefreshMs));
    const es = new EventSource(`/api/stream/tasks?${params.toString()}`);

    const onTasks = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as { tasks?: TaskRow[] };
        if (Array.isArray(payload.tasks)) setTasks(payload.tasks);
      } catch {
        // ignore
      }
    };

    es.addEventListener("tasks", onTasks as EventListener);

    return () => {
      es.removeEventListener("tasks", onTasks as EventListener);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, autoRefreshMs, groupFilter, selectedChannelId, status, taskType, limit]);

  const updateTask = async (task: TaskRow, action: "requeue" | "restart" | "pause" | "resume") => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: task.id, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update task");
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const retryFailedMessages = async () => {
    if (!selectedChannelId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/tasks/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: selectedChannelId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create retry task");
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const retryFailedDisabled = useMemo(() => !selectedChannelId || loading, [selectedChannelId, loading]);

  const visibleTasks = useMemo(() => {
    const filtered = tasks.filter((t) => t.taskType !== "history_partial");
    if (!hideCompleted) return filtered;
    return filtered.filter((t) => t.status !== "completed");
  }, [tasks, hideCompleted]);

  const groupedByChannel = useMemo(() => {
    const order: TaskType[] = ["resolve", "history_full", "realtime", "retry_failed"];

    const groups: Array<{
      sourceChannelId: string;
      source: TaskRow["source"];
      tasks: TaskRow[];
      summaryByType: Partial<Record<TaskType, TaskRow>>;
    }> = [];
    const byChannel = new Map<string, (typeof groups)[number]>();

    for (const t of visibleTasks) {
      let group = byChannel.get(t.sourceChannelId);
      if (!group) {
        group = { sourceChannelId: t.sourceChannelId, source: t.source, tasks: [], summaryByType: {} };
        byChannel.set(t.sourceChannelId, group);
        groups.push(group);
      }
      group.tasks.push(t);
      if (!group.summaryByType[t.taskType]) group.summaryByType[t.taskType] = t;
    }

    for (const group of groups) {
      group.tasks.sort((a, b) => {
        const ai = order.indexOf(a.taskType);
        const bi = order.indexOf(b.taskType);
        if (ai !== bi) return ai - bi;
        return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
      });
    }

    return groups;
  }, [visibleTasks]);

  return (
    <div className="space-y-6">
      {error ? (
        <div className="ui-alert-error">{error}</div>
      ) : null}
      {notice ? (
        <div className="ui-alert-info">{notice}</div>
      ) : null}

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
            <label className="block text-sm font-medium">频道（可选）</label>
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
                        ...visibleChannels.map((c) => ({ value: c.id, label: `${c.name} (${c.channelIdentifier})` })),
                      ]
                    : [{ value: "", label: channelsLoading ? "（加载中...）" : "（暂无频道）" }]
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">状态</label>
              <div className="mt-1">
                <Select
                  value={status}
                  onChange={(next) => setStatus(next)}
                  options={[
                    { value: "", label: "全部" },
                    { value: "pending", label: "pending" },
                    { value: "running", label: "running" },
                    { value: "paused", label: "paused" },
                    { value: "completed", label: "completed" },
                    { value: "failed", label: "failed" },
                  ]}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium">类型</label>
              <div className="mt-1">
                <Select
                  value={taskType}
                  onChange={(next) => setTaskType(next)}
                  options={[
                    { value: "", label: "全部" },
                    { value: "resolve", label: "resolve" },
                    { value: "history_full", label: "history_full" },
                    { value: "realtime", label: "realtime" },
                    { value: "retry_failed", label: "retry_failed" },
                  ]}
                />
              </div>
            </div>
          </div>

          <div className="rounded-md border border-black/10 bg-black/5 p-3 text-sm dark:border-white/10 dark:bg-white/5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">我的预设（保存到服务器）</div>
              <button
                type="button"
                onClick={() => saveCurrentAsPreset()}
                disabled={!canRefresh}
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
                      disabled={!canRefresh}
                      className="inline-flex h-8 items-center justify-center px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:text-slate-100 dark:hover:bg-white/10"
                      title={p.query}
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePreset(p.id)}
                      disabled={!canRefresh}
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
              <div className="font-medium">内置快捷（点一下就刷新）</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => applyPreset({ status: "running", taskType: "" })}
                  disabled={!canRefresh}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  运行中
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset({ status: "pending", taskType: "" })}
                  disabled={!canRefresh}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  待处理
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset({ status: "paused", taskType: "" })}
                  disabled={!canRefresh}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  暂停
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset({ status: "failed", taskType: "" })}
                  disabled={!canRefresh}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  失败
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset({ status: "", taskType: "resolve" })}
                  disabled={!canRefresh}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  resolve
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset({ status: "", taskType: "history_full" })}
                  disabled={!canRefresh}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  history_full
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset({ status: "", taskType: "realtime" })}
                  disabled={!canRefresh}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  realtime
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset({ status: "", taskType: "retry_failed" })}
                  disabled={!canRefresh}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-xs text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  retry_failed
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">数量</label>
              <div className="mt-1">
                <Select
                  value={String(limit)}
                  onChange={(value) => setLimit(Number.parseInt(value, 10))}
                  options={[
                    { value: "50", label: "50" },
                    { value: "100", label: "100" },
                    { value: "200", label: "200" },
                    { value: "500", label: "500" },
                  ]}
                />
              </div>
            </div>
	            <div className="flex items-end gap-2">
	              <button
	                type="button"
	                onClick={() => {
	                  setNotice("");
	                  syncUrlToCurrentQuery();
	                  void refresh();
	                }}
	                disabled={!canRefresh}
	                className="inline-flex h-10 items-center justify-center rounded-md bg-black px-4 text-sm text-white hover:bg-black/90 disabled:opacity-50"
	              >
	                {loading ? "加载中..." : refreshing ? "更新中..." : "刷新"}
	              </button>
	              <button
	                type="button"
	                onClick={() => {
	                  setNotice("");
	                  void copyQueryLink();
	                }}
	                disabled={loading}
	                className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
	              >
	                复制筛选链接
	              </button>
	              <button
	                type="button"
	                onClick={retryFailedMessages}
	                disabled={retryFailedDisabled}
                className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                重试 failed（创建任务）
              </button>
              <div className="flex items-center gap-3">
                <Checkbox label="实时更新" checked={autoRefresh} onChange={(checked) => setAutoRefresh(checked)} />
                <div className="w-28">
                  <Select
                    value={String(autoRefreshMs)}
                    onChange={(value) => setAutoRefreshMs(Number.parseInt(value, 10))}
                    disabled={!autoRefresh}
                    options={[
                      { value: "200", label: "0.2秒" },
                      { value: "500", label: "0.5秒" },
                      { value: "1000", label: "1秒" },
                      { value: "2000", label: "2秒" },
                      { value: "5000", label: "5秒" },
                      { value: "10000", label: "10秒" },
                    ]}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 pt-2 text-sm">
            <div className="inline-flex items-center gap-3">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="taskViewMode"
                  checked={viewMode === "channel"}
                  onChange={() => setViewMode("channel")}
                  className="ui-checkbox"
                />
                按频道显示（推荐）
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="taskViewMode"
                  checked={viewMode === "task"}
                  onChange={() => setViewMode("task")}
                  className="ui-checkbox"
                />
                按任务显示
              </label>
            </div>
            <Checkbox label="隐藏 completed" checked={hideCompleted} onChange={(checked) => setHideCompleted(checked)} />
          </div>
        </div>
      </div>

      <div className="ui-card">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="ui-section-title">任务列表</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
              {viewMode === "channel"
                ? groupedByChannel.length
                  ? `共 ${groupedByChannel.length} 个频道 · ${visibleTasks.length} 个任务`
                  : "暂无任务"
                : visibleTasks.length
                  ? `共 ${visibleTasks.length} 条`
                  : "暂无任务"}
            </p>
          </div>
	          <button
	            type="button"
	            onClick={() => {
	              setNotice("");
	              syncUrlToCurrentQuery();
	              void refresh();
	            }}
	            disabled={!canRefresh}
	            className="ui-btn ui-btn-secondary h-10"
	          >
	            {loading ? "刷新中..." : refreshing ? "更新中..." : "刷新"}
	          </button>
	        </div>

        {viewMode === "channel" ? (
          <div className="mt-4 space-y-4">
            {groupedByChannel.map((g) => (
              <div key={g.sourceChannelId} className="space-y-4">
                {g.tasks.map((t) => {
                  const statusLabel = labelTaskStatus(t.status);
                  const typeLabel = labelTaskType(t.taskType);
                  const pct = (() => {
                    const computed = calcProgressPct(t.progressCurrent, t.progressTotal);
                    if (typeof computed === "number" && Number.isFinite(computed)) return computed;
                    if (t.taskType === "realtime") return 100;
                    if (t.status === "completed") return 100;
                    return 0;
                  })();
                  const eta = estimateEta(t);
                  const startTime = formatClockTime(t.startedAt);
                  const progressText =
                    t.progressTotal != null ? `${t.progressCurrent.toLocaleString("zh-CN")} / ${t.progressTotal.toLocaleString("zh-CN")}` : `${t.progressCurrent.toLocaleString("zh-CN")} / -`;

                  const primaryAction = () => {
                    if (t.status === "running") return updateTask(t, "pause");
                    if (t.status === "paused") return updateTask(t, "resume");
                    return updateTask(t, "restart");
                  };
                  const refreshAction = () => {
                    if (t.status === "pending") return updateTask(t, "requeue");
                    return updateTask(t, "restart");
                  };

                  return (
                    <div key={t.id} className="glass-panel rounded-2xl p-6 hover-lift">
                      <div className="space-y-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h3 className="text-lg font-semibold text-gray-900 dark:text-slate-100 truncate">
                                <a href={`/channels/${encodeURIComponent(t.sourceChannelId)}`} className="hover:underline">
                                  {t.source.name}
                                </a>
                              </h3>
                              <span
                                className={clsx(
                                  "px-3 py-1 text-xs rounded-full font-medium",
                                  taskStatusBadgeClass(t.status),
                                )}
                              >
                                {statusLabel}
                              </span>
                            </div>
                            <p className="text-sm text-gray-600 dark:text-slate-300 mt-1">{typeLabel}</p>
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={primaryAction}
                              disabled={loading}
                              className="p-2 hover:bg-white/60 dark:hover:bg-slate-800/60 rounded-lg transition-all disabled:opacity-50"
                              title={t.status === "running" ? "暂停" : t.status === "paused" ? "恢复" : "重启"}
                            >
                              {t.status === "running" ? (
                                <Pause className="w-5 h-5 text-orange-600" />
                              ) : (
                                <Play className="w-5 h-5 text-green-600" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={refreshAction}
                              disabled={loading || t.status === "running"}
                              className="p-2 hover:bg-white/60 dark:hover:bg-slate-800/60 rounded-lg transition-all disabled:opacity-50"
                              title={t.status === "pending" ? "重排队" : "重启"}
                            >
                              <RefreshCw className="w-5 h-5 text-blue-600" />
                            </button>
                          </div>
                        </div>

                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm">
                              <div className="flex items-center gap-4">
                              <span className="text-gray-600 dark:text-slate-300">{progressText}</span>
                              {eta ? (
                                <div className="flex items-center gap-1 text-gray-500 dark:text-slate-400">
                                  <Clock className="w-4 h-4" />
                                  预计 {eta}
                                </div>
                              ) : null}
                              </div>
                            <span className="font-medium text-gray-900 dark:text-slate-100">{Math.round(pct)}%</span>
                            </div>
                          <div className="h-2 bg-gray-100 dark:bg-slate-800/60 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-blue-500 to-purple-600 rounded-full transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          </div>

                        <div className="flex items-center gap-6 text-sm text-gray-600 dark:text-slate-300">
                          <div>
                            <span className="text-gray-500 dark:text-slate-400">开始时间:</span> {startTime}
                          </div>
                          {t.status === "running" ? (
                            <div className="flex items-center gap-1">
                              <CheckCircle className="w-4 h-4 text-green-500" />
                              <span>同步正常</span>
                            </div>
                          ) : null}
                        </div>

                        {t.lastError ? (
                          <div className="space-y-1">
                            <div className="text-xs text-red-700 dark:text-red-200 whitespace-pre-wrap">{t.lastError}</div>
                            {(() => {
                              const hint = getFloodWaitAutoResumeHint(t);
                              return hint ? <div className="text-xs text-gray-500 dark:text-slate-400">{hint}</div> : null;
                            })()}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {visibleTasks.map((t) => {
              const statusLabel = labelTaskStatus(t.status);
              const typeLabel = labelTaskType(t.taskType);
              const pct = (() => {
                const computed = calcProgressPct(t.progressCurrent, t.progressTotal);
                if (typeof computed === "number" && Number.isFinite(computed)) return computed;
                if (t.taskType === "realtime") return 100;
                if (t.status === "completed") return 100;
                return 0;
              })();
              const eta = estimateEta(t);
              const startTime = formatClockTime(t.startedAt);
              const progressText =
                t.progressTotal != null ? `${t.progressCurrent.toLocaleString("zh-CN")} / ${t.progressTotal.toLocaleString("zh-CN")}` : `${t.progressCurrent.toLocaleString("zh-CN")} / -`;

              const primaryAction = () => {
                if (t.status === "running") return updateTask(t, "pause");
                if (t.status === "paused") return updateTask(t, "resume");
                return updateTask(t, "restart");
              };
              const refreshAction = () => {
                if (t.status === "pending") return updateTask(t, "requeue");
                return updateTask(t, "restart");
              };

              return (
                <div key={t.id} className="glass-panel rounded-2xl p-6 hover-lift">
                  <div className="space-y-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-semibold text-gray-900 dark:text-slate-100 truncate">
                            <a href={`/channels/${encodeURIComponent(t.sourceChannelId)}`} className="hover:underline">
                              {t.source.name}
                            </a>
                          </h3>
                          <span className={clsx("px-3 py-1 text-xs rounded-full font-medium", taskStatusBadgeClass(t.status))}>
                            {statusLabel}
                          </span>
                        </div>
                        <p className="text-sm text-gray-600 dark:text-slate-300 mt-1">{typeLabel}</p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={primaryAction}
                          disabled={loading}
                          className="p-2 hover:bg-white/60 dark:hover:bg-slate-800/60 rounded-lg transition-all disabled:opacity-50"
                          title={t.status === "running" ? "暂停" : t.status === "paused" ? "恢复" : "重启"}
                        >
                          {t.status === "running" ? (
                            <Pause className="w-5 h-5 text-orange-600" />
                          ) : (
                            <Play className="w-5 h-5 text-green-600" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={refreshAction}
                          disabled={loading || t.status === "running"}
                          className="p-2 hover:bg-white/60 dark:hover:bg-slate-800/60 rounded-lg transition-all disabled:opacity-50"
                          title={t.status === "pending" ? "重排队" : "重启"}
                        >
                          <RefreshCw className="w-5 h-5 text-blue-600" />
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-4">
                          <span className="text-gray-600 dark:text-slate-300">{progressText}</span>
                          {eta ? (
                            <div className="flex items-center gap-1 text-gray-500 dark:text-slate-400">
                              <Clock className="w-4 h-4" />
                              预计 {eta}
                            </div>
                          ) : null}
                        </div>
                        <span className="font-medium text-gray-900 dark:text-slate-100">{Math.round(pct)}%</span>
                      </div>
                      <div className="h-2 bg-gray-100 dark:bg-slate-800/60 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-purple-600 rounded-full transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>

                    <div className="flex items-center gap-6 text-sm text-gray-600 dark:text-slate-300">
                      <div>
                        <span className="text-gray-500 dark:text-slate-400">开始时间:</span> {startTime}
                      </div>
                      {t.status === "running" ? (
                        <div className="flex items-center gap-1">
                          <CheckCircle className="w-4 h-4 text-green-500" />
                          <span>同步正常</span>
                        </div>
                      ) : null}
                    </div>

                    {t.lastError ? (
                      <div className="space-y-1">
                        <div className="text-xs text-red-700 dark:text-red-200 whitespace-pre-wrap">{t.lastError}</div>
                        {(() => {
                          const hint = getFloodWaitAutoResumeHint(t);
                          return hint ? <div className="text-xs text-gray-500 dark:text-slate-400">{hint}</div> : null;
                        })()}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
