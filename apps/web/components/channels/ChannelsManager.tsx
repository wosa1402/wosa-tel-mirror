"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Clock, MessageSquare, Pause, Play, Trash2, Users } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { type LocalQueryPreset } from "@/lib/local-presets";
import { deleteQueryPreset, loadQueryPresets, saveQueryPreset } from "@/lib/query-presets";

type MirrorMode = "forward" | "copy";
type MirrorTarget = "manual" | "auto";

type TaskStatus = "pending" | "running" | "paused" | "completed" | "failed";
type TaskType = "resolve" | "history_full" | "history_partial" | "realtime" | "retry_failed";

type TaskSummary = {
  id: string;
  status: TaskStatus;
  progressCurrent: number;
  progressTotal: number | null;
  lastProcessedId: number | null;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  pausedAt: string | null;
};

type ChannelRow = {
  id: string;
  groupName: string;
  channelIdentifier: string;
  telegramId: string | null;
  accessHash: string | null;
  name: string;
  username: string | null;
  description: string | null;
  memberCount: number | null;
  totalMessages: number | null;
  syncStatus: string;
  lastSyncAt: string | null;
  lastMessageId: number | null;
  isActive: boolean;
  isProtected: boolean;
  mirrorMode: MirrorMode | null;
  priority: number;
  tasks: Partial<Record<TaskType, TaskSummary>>;
  messageStats: {
    total: number;
    pending: number;
    success: number;
    failed: number;
    skipped: number;
    skippedProtectedContent: number;
  };
  lastEvent:
    | {
        id: string;
        level: "info" | "warn" | "error";
        message: string;
        createdAt: string;
      }
    | null;
  lastErrorEvent:
    | {
        id: string;
        level: "info" | "warn" | "error";
        message: string;
        createdAt: string;
      }
    | null;
  mirrorChannel:
    | {
        id: string;
        channelIdentifier: string;
        telegramId: string | null;
        accessHash: string | null;
        name: string;
        username: string | null;
        inviteLink: string | null;
        isAutoCreated: boolean;
      }
    | null;
};

type TelegramChannelOption = {
  title: string;
  identifier: string;
  username: string | null;
  telegramId: string | null;
};

const UNGROUPED = "__ungrouped__";
const PRESETS_STORAGE_KEY = "tg-back:presets:channels";

type BulkAddProgress = {
  total: number;
  processed: number;
  created: number;
  existed: number;
  failed: number;
  current: string | null;
  failures: Array<{ identifier: string; error: string }>;
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

function formatRelativeTime(value: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  const ts = d.getTime();
  if (!Number.isFinite(ts)) return value;
  const diffMs = Date.now() - ts;
  if (!Number.isFinite(diffMs)) return value;
  if (diffMs < 15_000) return "刚刚";
  if (diffMs < 60_000) return `${Math.max(1, Math.floor(diffMs / 1000))} 秒前`;
  if (diffMs < 60 * 60_000) return `${Math.max(1, Math.floor(diffMs / 60_000))} 分钟前`;
  if (diffMs < 24 * 60 * 60_000) return `${Math.max(1, Math.floor(diffMs / (60 * 60_000)))} 小时前`;
  if (diffMs < 7 * 24 * 60 * 60_000) return `${Math.max(1, Math.floor(diffMs / (24 * 60 * 60_000)))} 天前`;
  return d.toLocaleDateString("zh-CN");
}

function getAvatarText(name: string, identifier: string): string {
  const base = (name || identifier || "").trim();
  if (!base) return "TG";
  const letters = base
    .replace(/@/g, "")
    .replace(/https?:\/\/t\.me\//g, "")
    .replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, " ")
    .split(/\s+/g)
    .filter(Boolean)
    .join("");
  const picked = letters.slice(0, 2);
  return picked.toUpperCase();
}

function labelSyncStatus(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v === "syncing") return "同步中";
  if (v === "completed") return "已完成";
  if (v === "pending") return "等待中";
  if (v === "error") return "异常";
  return raw || "-";
}

function syncStatusBadgeClass(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v === "completed") return "ui-badge-success";
  if (v === "syncing") return "ui-badge-info";
  if (v === "pending") return "ui-badge-muted";
  if (v === "error") return "ui-badge-error";
  return "ui-badge-muted";
}

function calcProgressPct(current: number, total: number | null): number | null {
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(current) || current <= 0) return 0;
  return Math.max(0, Math.min(100, (current / total) * 100));
}

function truncateText(value: string, maxLen: number): string {
  const text = value.trim();
  if (!text) return "(空)";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function parseBulkIdentifiers(input: string): string[] {
  const tokens = input
    .split(/[\s,，;；]+/g)
    .map((t) => t.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

export function ChannelsManager({
  initialGroupName = "",
  initialQuery = "",
  initialActiveFilter = "all",
  initialProtectedFilter = "all",
  initialResolvedFilter = "all",
  initialSyncStatusFilter = "all",
  initialSortBy = "default",
}: {
  initialGroupName?: string;
  initialQuery?: string;
  initialActiveFilter?: "all" | "active" | "inactive";
  initialProtectedFilter?: "all" | "protected" | "unprotected";
  initialResolvedFilter?: "all" | "resolved" | "unresolved";
  initialSyncStatusFilter?: "all" | "pending" | "syncing" | "completed" | "error";
  initialSortBy?: "default" | "priority_desc" | "name_asc" | "last_sync_desc";
}) {
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoRefreshMs, setAutoRefreshMs] = useState(1000);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTimerRef = useRef<number | null>(null);
  const refreshRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(async () => {});
  const loadingRef = useRef(false);
  const refreshingRef = useRef(false);

  const [sourceChannelIdentifier, setSourceChannelIdentifier] = useState("");
  const [bulkAddMode, setBulkAddMode] = useState(false);
  const [bulkSourceIdentifiers, setBulkSourceIdentifiers] = useState("");
  const [bulkAddProgress, setBulkAddProgress] = useState<BulkAddProgress | null>(null);
  const [newGroupName, setNewGroupName] = useState(() => {
    const trimmed = initialGroupName.trim();
    return trimmed && trimmed !== UNGROUPED ? trimmed : "";
  });
  const [newPriority, setNewPriority] = useState("0");
  const [mirrorChannelIdentifier, setMirrorChannelIdentifier] = useState("me");
  const [mirrorMode, setMirrorMode] = useState<MirrorMode>("forward");
  const [mirrorTarget, setMirrorTarget] = useState<MirrorTarget>("manual");

  const [priorityDrafts, setPriorityDrafts] = useState<Record<string, string>>({});
  const [groupNameDrafts, setGroupNameDrafts] = useState<Record<string, string>>({});

  const [listQuery, setListQuery] = useState(initialQuery);
  const [groupFilter, setGroupFilter] = useState<string>(initialGroupName);
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">(initialActiveFilter);
  const [protectedFilter, setProtectedFilter] = useState<"all" | "protected" | "unprotected">(initialProtectedFilter);
  const [resolvedFilter, setResolvedFilter] = useState<"all" | "resolved" | "unresolved">(initialResolvedFilter);
  const [syncStatusFilter, setSyncStatusFilter] = useState<"all" | "pending" | "syncing" | "completed" | "error">(
    initialSyncStatusFilter,
  );
  const [sortBy, setSortBy] = useState<"default" | "priority_desc" | "name_asc" | "last_sync_desc">(initialSortBy);

  const [savedPresets, setSavedPresets] = useState<LocalQueryPreset[]>([]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<"source" | "mirror">("source");
  const [telegramChannels, setTelegramChannels] = useState<TelegramChannelOption[]>([]);
  const [telegramChannelsLoading, setTelegramChannelsLoading] = useState(false);
  const [telegramChannelsError, setTelegramChannelsError] = useState("");
  const [telegramChannelsQuery, setTelegramChannelsQuery] = useState("");
  const [telegramChannelsFetchedAt, setTelegramChannelsFetchedAt] = useState<number | null>(null);

  const exportChannelsTxtUrl = useMemo(() => "/api/export/channels?format=txt", []);
  const exportChannelsJsonlUrl = useMemo(() => "/api/export/channels?format=jsonl", []);

  const unresolvedCount = useMemo(
    () => channels.filter((c) => !c.telegramId || !c.mirrorChannel?.telegramId).length,
    [channels],
  );

  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(""), 3000);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const presets = await loadQueryPresets({ scope: "channels", storageKey: PRESETS_STORAGE_KEY });
      if (!cancelled) setSavedPresets(presets);
    })();
    return () => {
      cancelled = true;
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const groupOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of channels) {
      const name = typeof c.groupName === "string" ? c.groupName.trim() : "";
      if (name) set.add(name);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [channels]);

  const hasUngrouped = useMemo(() => channels.some((c) => !(c.groupName ?? "").trim()), [channels]);

  const visibleChannels = useMemo(() => {
    const query = listQuery.trim().toLowerCase();
    const group = groupFilter.trim();

    const filtered = channels.filter((c) => {
      if (group) {
        const name = typeof c.groupName === "string" ? c.groupName.trim() : "";
        if (group === UNGROUPED) {
          if (name) return false;
        } else if (name !== group) return false;
      }
      if (activeFilter === "active" && !c.isActive) return false;
      if (activeFilter === "inactive" && c.isActive) return false;
      if (protectedFilter === "protected" && !c.isProtected) return false;
      if (protectedFilter === "unprotected" && c.isProtected) return false;

      const resolved = !!(c.telegramId && c.mirrorChannel?.telegramId);
      if (resolvedFilter === "resolved" && !resolved) return false;
      if (resolvedFilter === "unresolved" && resolved) return false;

      if (syncStatusFilter !== "all" && c.syncStatus !== syncStatusFilter) return false;

      if (!query) return true;

      const haystack = [
        c.groupName ?? "",
        c.name,
        c.channelIdentifier,
        c.username ? `@${c.username}` : "",
        c.telegramId ?? "",
        c.mirrorChannel?.name ?? "",
        c.mirrorChannel?.channelIdentifier ?? "",
        c.mirrorChannel?.username ? `@${c.mirrorChannel.username}` : "",
        c.mirrorChannel?.telegramId ?? "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });

    if (sortBy === "priority_desc") {
      return [...filtered].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    }
    if (sortBy === "name_asc") {
      return [...filtered].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
    }
    if (sortBy === "last_sync_desc") {
      const toTs = (value: string | null) => {
        if (!value) return -1;
        const t = new Date(value).getTime();
        return Number.isFinite(t) ? t : -1;
      };
      return [...filtered].sort((a, b) => toTs(b.lastSyncAt) - toTs(a.lastSyncAt));
    }

    return filtered;
  }, [channels, listQuery, groupFilter, activeFilter, protectedFilter, resolvedFilter, syncStatusFilter, sortBy]);

  useEffect(() => {
    setGroupFilter(initialGroupName);
  }, [initialGroupName]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    syncUrlToCurrentFilters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupFilter, listQuery, activeFilter, protectedFilter, resolvedFilter, syncStatusFilter, sortBy]);

  const buildShareQuery = (): string => {
    const params = new URLSearchParams();
    const group = groupFilter.trim();
    if (group) {
      if (group === UNGROUPED) params.set("groupName", "");
      else params.set("groupName", group);
    }
    if (listQuery.trim()) params.set("q", listQuery.trim());
    if (activeFilter !== "all") params.set("active", activeFilter);
    if (protectedFilter !== "all") params.set("protected", protectedFilter);
    if (resolvedFilter !== "all") params.set("resolved", resolvedFilter);
    if (syncStatusFilter !== "all") params.set("syncStatus", syncStatusFilter);
    if (sortBy !== "default") params.set("sortBy", sortBy);
    return params.toString();
  };

  const buildShareUrl = (): string => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    const query = buildShareQuery();
    url.search = query ? `?${query}` : "";
    return url.toString();
  };

  const syncUrlToCurrentFilters = () => {
    const nextUrl = buildShareUrl();
    if (!nextUrl) return;
    window.history.replaceState(null, "", nextUrl);
  };

  const copyFilterLink = async () => {
    const url = buildShareUrl();
    if (!url) return;
    syncUrlToCurrentFilters();
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

  const saveCurrentAsPreset = async () => {
    const currentQuery = buildShareQuery();
    const groupLabel = groupFilter === UNGROUPED ? "未分组" : groupFilter.trim();
    const parts: string[] = [];
    if (groupLabel) parts.push(`分组:${groupLabel}`);
    if (listQuery.trim()) parts.push(`关键词:${listQuery.trim().slice(0, 12)}`);
    if (syncStatusFilter !== "all") parts.push(syncStatusFilter);
    if (activeFilter !== "all") parts.push(activeFilter);
    if (protectedFilter !== "all") parts.push(protectedFilter);
    if (resolvedFilter !== "all") parts.push(resolvedFilter);
    if (!parts.length) parts.push("全部");
    const suggested = parts.join(" ");

    const name = window.prompt("给这个预设起个名字：", suggested)?.trim() ?? "";
    if (!name) return;

    const next = await saveQueryPreset({ scope: "channels", name, query: currentQuery, storageKey: PRESETS_STORAGE_KEY });
    setSavedPresets(next);
    showNotice("已保存预设");
  };

  const deletePreset = async (id: string) => {
    const next = await deleteQueryPreset({ scope: "channels", id, storageKey: PRESETS_STORAGE_KEY });
    setSavedPresets(next);
    showNotice("已删除预设");
  };

  const applyPresetQueryString = (query: string) => {
    const params = new URLSearchParams(query);
    const groupHas = params.has("groupName") || params.has("group_name");
    const groupRaw = (params.get("groupName") ?? params.get("group_name") ?? "").trim();
    const nextGroupFilter = groupHas ? (groupRaw ? groupRaw : UNGROUPED) : "";

    const nextQuery = (params.get("q") ?? "").trim();

    const activeRaw = (params.get("active") ?? "").trim();
    const nextActive = activeRaw === "active" || activeRaw === "inactive" ? activeRaw : "all";

    const protectedRaw = (params.get("protected") ?? "").trim();
    const nextProtected = protectedRaw === "protected" || protectedRaw === "unprotected" ? protectedRaw : "all";

    const resolvedRaw = (params.get("resolved") ?? "").trim();
    const nextResolved = resolvedRaw === "resolved" || resolvedRaw === "unresolved" ? resolvedRaw : "all";

    const syncStatusRaw = (params.get("syncStatus") ?? params.get("sync_status") ?? "").trim();
    const nextSyncStatus =
      syncStatusRaw === "pending" || syncStatusRaw === "syncing" || syncStatusRaw === "completed" || syncStatusRaw === "error"
        ? syncStatusRaw
        : "all";

    const sortRaw = (params.get("sortBy") ?? params.get("sort_by") ?? "").trim();
    const nextSortBy =
      sortRaw === "priority_desc" || sortRaw === "name_asc" || sortRaw === "last_sync_desc" ? sortRaw : "default";

    setNotice("");
    setListQuery(nextQuery);
    setGroupFilter(nextGroupFilter);
    setActiveFilter(nextActive as typeof activeFilter);
    setProtectedFilter(nextProtected as typeof protectedFilter);
    setResolvedFilter(nextResolved as typeof resolvedFilter);
    setSyncStatusFilter(nextSyncStatus as typeof syncStatusFilter);
    setSortBy(nextSortBy as typeof sortBy);
    showNotice("已应用预设");
  };

  const copyChannelIdentifiers = async () => {
    setNotice("");
    try {
      const res = await fetch(exportChannelsTxtUrl, { cache: "no-store" });
      const text = await res.text();
      if (!res.ok) throw new Error(text || "Failed to export channels");

      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          showNotice("已复制频道清单（每行一个标识）");
          return;
        } catch {
          // fallthrough
        }
      }

      window.prompt("复制下面这个频道清单（每行一个标识）：", text);
    } catch (e: unknown) {
      showNotice(`导出失败：${getErrorMessage(e)}`);
    }
  };

  const filteredTelegramChannels = useMemo(() => {
    const q = telegramChannelsQuery.trim().toLowerCase();
    if (!q) return telegramChannels;
    return telegramChannels.filter((c) => {
      const title = c.title.toLowerCase();
      const identifier = c.identifier.toLowerCase();
      const username = (c.username ?? "").toLowerCase();
      const telegramId = (c.telegramId ?? "").toLowerCase();
      return title.includes(q) || identifier.includes(q) || username.includes(q) || telegramId.includes(q);
    });
  }, [telegramChannels, telegramChannelsQuery]);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/channels", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load channels");
      setChannels(data.channels ?? []);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  const refreshSilently = async () => {
    setRefreshing(true);
    setError("");
    try {
      const res = await fetch("/api/channels", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load channels");
      setChannels(data.channels ?? []);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };

  refreshRef.current = refreshSilently;
  loadingRef.current = loading;
  refreshingRef.current = refreshing;

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (loadingRef.current || refreshingRef.current) return;
      void refreshRef.current().catch(() => {});
    }, autoRefreshMs);
    return () => window.clearInterval(id);
  }, [autoRefresh, autoRefreshMs]);

  useEffect(() => {
    if (!autoRefresh) return;
    if (typeof EventSource === "undefined") return;

    const params = new URLSearchParams();
    params.set("limit", "500");
    params.set("intervalMs", String(autoRefreshMs));
    const es = new EventSource(`/api/stream/tasks?${params.toString()}`);

    const onTasks = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as {
          tasks?: Array<{
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
          }>;
        };
        if (!Array.isArray(payload.tasks)) return;

        const byChannel = new Map<string, Partial<Record<TaskType, TaskSummary>>>();
        for (const t of payload.tasks) {
          let byType = byChannel.get(t.sourceChannelId);
          if (!byType) {
            byType = {};
            byChannel.set(t.sourceChannelId, byType);
          }
          if (byType[t.taskType]) continue;
          byType[t.taskType] = {
            id: t.id,
            status: t.status,
            progressCurrent: t.progressCurrent,
            progressTotal: t.progressTotal,
            lastProcessedId: t.lastProcessedId,
            lastError: t.lastError,
            createdAt: t.createdAt,
            startedAt: t.startedAt,
            completedAt: t.completedAt,
            pausedAt: t.pausedAt,
          };
        }

        setChannels((prev) =>
          prev.map((c) => {
            const patch = byChannel.get(c.id);
            if (!patch) return c;
            return { ...c, tasks: { ...c.tasks, ...patch } };
          }),
        );
      } catch {
        // ignore
      }
    };

    es.addEventListener("tasks", onTasks as EventListener);

    return () => {
      es.removeEventListener("tasks", onTasks as EventListener);
      es.close();
    };
  }, [autoRefresh, autoRefreshMs]);

  const setPriorityDraft = (channelId: string, value: string) => {
    setPriorityDrafts((prev) => ({ ...prev, [channelId]: value }));
  };

  const setGroupNameDraft = (channelId: string, value: string) => {
    setGroupNameDrafts((prev) => ({ ...prev, [channelId]: value }));
  };

  const savePriority = async (channel: ChannelRow) => {
    setLoading(true);
    setError("");
    try {
      const raw = (priorityDrafts[channel.id] ?? String(channel.priority ?? 0)).trim();
      const parsed = raw ? Number.parseInt(raw, 10) : 0;
      if (!Number.isFinite(parsed)) throw new Error("priority 必须是整数");
      const priority = Math.max(-100, Math.min(100, Math.trunc(parsed)));

      const res = await fetch("/api/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id, priority }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update priority");

      await refresh();
      setPriorityDrafts((prev) => {
        const next = { ...prev };
        delete next[channel.id];
        return next;
      });
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const saveGroupName = async (channel: ChannelRow) => {
    setLoading(true);
    setError("");
    try {
      const raw = (groupNameDrafts[channel.id] ?? channel.groupName ?? "").trim();
      const groupName = raw.slice(0, 50);

      const res = await fetch("/api/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id, groupName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update group name");

      await refresh();
      setGroupNameDrafts((prev) => {
        const next = { ...prev };
        delete next[channel.id];
        return next;
      });
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const loadTelegramChannels = async ({ force }: { force?: boolean } = {}) => {
    setTelegramChannelsLoading(true);
    setTelegramChannelsError("");
    try {
      if (!force && telegramChannelsFetchedAt && Date.now() - telegramChannelsFetchedAt < 30_000) return;
      const res = await fetch("/api/telegram/dialogs?limit=300");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load Telegram channels");
      setTelegramChannels(Array.isArray(data.channels) ? data.channels : []);
      setTelegramChannelsFetchedAt(Date.now());
    } catch (e: unknown) {
      setTelegramChannelsError(getErrorMessage(e));
    } finally {
      setTelegramChannelsLoading(false);
    }
  };

  const openPicker = (target: "source" | "mirror") => {
    setPickerTarget(target);
    setPickerOpen(true);
    setTelegramChannelsQuery("");
    void loadTelegramChannels();
  };

  const closePicker = () => {
    setPickerOpen(false);
    setTelegramChannelsError("");
  };

  const chooseTelegramChannel = (item: TelegramChannelOption) => {
    if (pickerTarget === "source") {
      if (bulkAddMode) {
        setBulkSourceIdentifiers((prev) => {
          const trimmed = prev.trim();
          if (!trimmed) return item.identifier;
          const lines = trimmed.split(/\r?\n/g).map((l) => l.trim());
          if (lines.includes(item.identifier)) return prev;
          return `${trimmed}\n${item.identifier}`;
        });
      } else {
        setSourceChannelIdentifier(item.identifier);
      }
    } else {
      setMirrorChannelIdentifier(item.identifier);
    }
    closePicker();
  };

  const addChannel = async () => {
    setLoading(true);
    setError("");
    try {
      const rawGroupName = newGroupName.trim();
      const groupName = rawGroupName ? rawGroupName.slice(0, 50) : "";

      const rawPriority = newPriority.trim();
      const parsedPriority = rawPriority ? Number.parseInt(rawPriority, 10) : 0;
      if (!Number.isFinite(parsedPriority)) throw new Error("优先级必须是整数（-100~100）");
      const priority = Math.max(-100, Math.min(100, Math.trunc(parsedPriority)));

      if (!bulkAddMode) {
        const res = await fetch("/api/channels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceChannelIdentifier,
            groupName,
            priority,
            mirrorTarget,
            mirrorChannelIdentifier: mirrorTarget === "auto" ? "" : mirrorChannelIdentifier,
            mirrorMode,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to add channel");
        setSourceChannelIdentifier("");
      } else {
        const identifiers = parseBulkIdentifiers(bulkSourceIdentifiers);
        if (!identifiers.length) throw new Error("请粘贴至少 1 个源频道（每行一个或用空格/逗号分隔）");
        if (identifiers.length > 100) throw new Error(`一次最多批量添加 100 个频道（当前：${identifiers.length}）`);

        setBulkAddProgress({
          total: identifiers.length,
          processed: 0,
          created: 0,
          existed: 0,
          failed: 0,
          current: null,
          failures: [],
        });

        let created = 0;
        let existed = 0;
        const failures: Array<{ identifier: string; error: string }> = [];

        for (let i = 0; i < identifiers.length; i++) {
          const id = identifiers[i]!;
          setBulkAddProgress((prev) =>
            prev
              ? {
                  ...prev,
                  processed: i,
                  current: id,
                }
              : prev,
          );

          try {
            const res = await fetch("/api/channels", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sourceChannelIdentifier: id,
                groupName,
                priority,
                mirrorTarget,
                mirrorChannelIdentifier: mirrorTarget === "auto" ? "" : mirrorChannelIdentifier,
                mirrorMode,
              }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error((data as { error?: string }).error ?? "Failed to add channel");
            if ((data as { alreadyExists?: boolean }).alreadyExists) existed++;
            else created++;
          } catch (e: unknown) {
            failures.push({ identifier: id, error: getErrorMessage(e) });
          }

          setBulkAddProgress((prev) =>
            prev
              ? {
                  ...prev,
                  processed: i + 1,
                  created,
                  existed,
                  failed: failures.length,
                  current: i + 1 >= identifiers.length ? null : prev.current,
                  failures: failures.slice(-20),
                }
              : prev,
          );
        }

        if (!failures.length) setBulkSourceIdentifiers("");
        setBulkAddProgress((prev) =>
          prev
            ? {
                ...prev,
                processed: identifiers.length,
                created,
                existed,
                failed: failures.length,
                current: null,
                failures: failures.slice(-50),
              }
            : prev,
        );
      }

      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const retryResolve = async (channel: ChannelRow) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannelIdentifier: channel.channelIdentifier,
          mirrorTarget: channel.mirrorChannel?.isAutoCreated ? "auto" : "manual",
          mirrorChannelIdentifier: channel.mirrorChannel?.channelIdentifier ?? "me",
          mirrorMode: channel.mirrorMode ?? "forward",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to retry");
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleActive = async (channel: ChannelRow) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id, isActive: !channel.isActive }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update channel");
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const recoverSyncStatus = async (channel: ChannelRow) => {
    if (!confirm(`确认恢复频道 ${channel.channelIdentifier} 吗？这会把 syncStatus 从 error 改回 pending，并让 mirror-service 重新尝试执行任务。`)) {
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id, recoverSyncStatus: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to recover channel");
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const deleteChannel = async (channel: ChannelRow) => {
    if (!confirm(`确认删除频道 ${channel.channelIdentifier} 吗？这会清空该频道的任务与消息映射记录。`)) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/channels", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to delete channel");
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
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
        <h2 className="ui-section-title">添加频道</h2>
        <div className="mt-4 grid grid-cols-1 gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-gray-600 dark:text-slate-300">提示：批量添加适合一次性添加很多频道。</div>
            <Checkbox
              label="批量添加"
              checked={bulkAddMode}
              onChange={(checked) => {
                setBulkAddMode(checked);
                setBulkAddProgress(null);
                if (!checked) setBulkSourceIdentifiers("");
              }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">源频道（@username / t.me 链接 / 邀请链接 / -100...）</label>
            {bulkAddMode ? (
              <div className="mt-1 space-y-2">
                <textarea
                  value={bulkSourceIdentifiers}
                  onChange={(e) => setBulkSourceIdentifiers(e.target.value)}
                  placeholder={`每行一个源频道，例如：\n@source_channel\nhttps://t.me/+xxxxx\n-1001234567890`}
                  rows={5}
                  className="ui-textarea"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-gray-600 dark:text-slate-300">支持换行/空格/逗号分隔，会自动去重。</div>
                  <button
                    type="button"
                    onClick={() => openPicker("source")}
                    className="ui-btn ui-btn-secondary h-9"
                  >
                    从 Telegram 选择并追加
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-1 flex gap-2">
                <input
                  value={sourceChannelIdentifier}
                  onChange={(e) => setSourceChannelIdentifier(e.target.value)}
                  placeholder="@source_channel / https://t.me/+xxxxx / -1001234567890"
                  className="ui-input flex-1"
                />
                <button
                  type="button"
                  onClick={() => openPicker("source")}
                  className="ui-btn ui-btn-secondary h-10 shrink-0"
                >
                  从 Telegram 选择
                </button>
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">分组（可选）</label>
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="例如：工作 / 备份测试（留空=未分组）"
                className="ui-input mt-1"
              />
              <div className="mt-1 text-xs text-gray-600 dark:text-slate-300">最多 50 个字，留空表示“不分组”。</div>
            </div>
            <div>
              <label className="block text-sm font-medium">优先级（-100~100，越大越优先）</label>
              <input
                type="number"
                min={-100}
                max={100}
                step={1}
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value)}
                className="ui-input mt-1"
              />
              <div className="mt-1 text-xs text-gray-600 dark:text-slate-300">默认 0；比如设 10，表示这个频道任务更优先跑。</div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium">镜像目标</label>
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="mirrorTarget"
                    value="manual"
                    checked={mirrorTarget === "manual"}
                    onChange={() => setMirrorTarget("manual")}
                  />
                  指定频道（输入/选择）
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="mirrorTarget"
                    value="auto"
                    checked={mirrorTarget === "auto"}
                    onChange={() => setMirrorTarget("auto")}
                  />
                  自动创建镜像频道（私密）
                </label>
              </div>

              {mirrorTarget === "manual" ? (
                <div className="flex gap-2">
                  <input
                    value={mirrorChannelIdentifier}
                    onChange={(e) => setMirrorChannelIdentifier(e.target.value)}
                    placeholder="me / @backup_channel / https://t.me/+xxxxx / -1001234567890"
                    className="h-10 w-full flex-1 rounded-md border border-black/10 bg-white px-3 text-sm text-gray-900 outline-none focus:border-black/30 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:focus:border-white/20"
                  />
                  <button
                    type="button"
                    onClick={() => openPicker("mirror")}
                    className="inline-flex h-10 shrink-0 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                  >
                    从 Telegram 选择
                  </button>
                </div>
              ) : (
                <div className="rounded-md border border-black/10 bg-black/[0.02] p-3 text-sm text-black/70 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                  将由 mirror-service 使用当前登录账号创建一个新的私密频道作为备份频道。可在{" "}
                  <a href="/settings" className="underline">
                    系统设置
                  </a>{" "}
                  中调整频道前缀（auto_channel_prefix）。
                </div>
              )}

              {bulkAddMode && mirrorTarget === "manual" ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                  批量添加提示：如果你选择“指定频道”，这一批新增的源频道都会指向同一个备份频道（消息会混在一起）。如果你想每个源频道独立备份，建议选“自动创建镜像频道”。
                </div>
              ) : null}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium">镜像方式</label>
            <div className="mt-1 max-w-md">
              <Select
                value={mirrorMode}
                onChange={(next) => setMirrorMode(next as MirrorMode)}
                options={[
                  { value: "forward", label: "forward（无署名复制，支持媒体/相册）" },
                  { value: "copy", label: "copy（仅文本，当前用于测试）" },
                ]}
              />
            </div>
          </div>
          <div className="pt-2">
            <button
              type="button"
              onClick={addChannel}
              disabled={loading || (bulkAddMode ? parseBulkIdentifiers(bulkSourceIdentifiers).length === 0 : !sourceChannelIdentifier.trim())}
              className="inline-flex h-10 items-center justify-center rounded-md bg-black px-4 text-sm text-white hover:bg-black/90 disabled:opacity-50"
            >
              {loading ? "处理中..." : bulkAddMode ? "批量添加并创建任务" : "添加并创建任务"}
            </button>

            {bulkAddMode && bulkAddProgress ? (
              <div className="mt-3 rounded-md border border-black/10 bg-black/[0.02] p-3 text-sm dark:border-white/10 dark:bg-white/5">
                <div className="text-black/70 dark:text-slate-300">
                  批量添加进度：{bulkAddProgress.processed}/{bulkAddProgress.total}（创建 {bulkAddProgress.created} · 已存在{" "}
                  {bulkAddProgress.existed} · 失败 {bulkAddProgress.failed}）
                </div>
                {bulkAddProgress.current ? (
                  <div className="mt-1 text-xs text-black/60 dark:text-slate-400">当前：{bulkAddProgress.current}</div>
                ) : null}
                {bulkAddProgress.failures.length ? (
                  <div className="mt-2 space-y-1 text-xs text-red-800 dark:text-red-200">
                    <div className="font-medium">最近失败：</div>
                    {bulkAddProgress.failures.slice(-10).map((f) => (
                      <div key={`${f.identifier}-${f.error}`} className="whitespace-pre-wrap">
                        - {f.identifier}: {truncateText(f.error, 160)}
                      </div>
                    ))}
                    <div className="text-black/50 dark:text-slate-400">提示：失败不会影响其他成功的频道，你可以只复制失败项再试一次。</div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {pickerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => closePicker()}>
          <div
            className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-lg dark:bg-slate-950 dark:text-slate-100 dark:shadow-black/40 dark:border dark:border-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-base font-semibold">
                  从 Telegram 选择{pickerTarget === "source" ? "源频道" : "镜像目标"}
                </div>
                <div className="mt-1 text-sm text-black/60 dark:text-slate-400">
                  仅展示你账号可访问的频道（包含无 username 的私密频道，会用 -100... 标识）。
                </div>
              </div>
              <button
                type="button"
                onClick={() => closePicker()}
                className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-sm text-gray-900 hover:bg-black/5 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                关闭
              </button>
            </div>

            <div className="mt-4 flex gap-2">
              <input
                value={telegramChannelsQuery}
                onChange={(e) => setTelegramChannelsQuery(e.target.value)}
                placeholder="搜索标题 / @username / -100..."
                className="h-10 w-full flex-1 rounded-md border border-black/10 bg-white px-3 text-sm text-gray-900 outline-none focus:border-black/30 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:focus:border-white/20"
              />
              <button
                type="button"
                onClick={() => void loadTelegramChannels({ force: true })}
                disabled={telegramChannelsLoading}
                className="inline-flex h-10 shrink-0 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                {telegramChannelsLoading ? "加载中..." : "刷新列表"}
              </button>
            </div>

            {telegramChannelsError ? (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
                {telegramChannelsError}
              </div>
            ) : null}

            <div className="mt-4 max-h-[60vh] overflow-auto rounded-md border border-black/10 dark:border-white/10">
              {telegramChannelsLoading && telegramChannels.length === 0 ? (
                <div className="p-4 text-sm text-black/60 dark:text-slate-400">加载中...</div>
              ) : filteredTelegramChannels.length === 0 ? (
                <div className="p-4 text-sm text-black/60 dark:text-slate-400">
                  暂无可选频道{telegramChannelsQuery.trim() ? "（可尝试清空搜索词或刷新列表）" : ""}。
                </div>
              ) : (
                <ul className="divide-y divide-black/5 dark:divide-white/10">
                  {filteredTelegramChannels.map((c) => (
                    <li key={c.identifier}>
                      <button
                        type="button"
                        onClick={() => chooseTelegramChannel(c)}
                        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-black/5 dark:hover:bg-white/10"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{c.title}</div>
                          <div className="mt-0.5 truncate text-xs text-black/60 dark:text-slate-400">
                            {c.username ? `${c.username} · ` : ""}
                            {c.identifier}
                            {c.telegramId ? ` · id=${c.telegramId}` : ""}
                          </div>
                        </div>
                        <div className="shrink-0 text-xs text-black/60 dark:text-slate-400">选择</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}

	      <div className="ui-card">
	        <div className="flex items-center justify-between">
	          <div>
	            <h2 className="ui-section-title">频道列表</h2>
	            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">
	              共 {channels.length} 个频道{visibleChannels.length !== channels.length ? ` · 筛选后 ${visibleChannels.length} 个` : ""} ·
	              未解析/未就绪：{unresolvedCount}（需要运行 mirror-service 来 resolve 并开始同步）
	            </p>
	          </div>
		          <div className="flex items-center gap-4">
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
			            <button
			              type="button"
			              onClick={() => {
			                setNotice("");
			                syncUrlToCurrentFilters();
			                void refresh();
			              }}
			              disabled={loading}
		              className="ui-btn ui-btn-secondary h-10"
		            >
		              {loading ? "刷新中..." : refreshing ? "更新中..." : "刷新"}
		            </button>
		            <button
		              type="button"
		              onClick={() => {
		                setNotice("");
		                void copyFilterLink();
		              }}
		              disabled={loading}
		              className="ui-btn ui-btn-secondary h-10"
		            >
		              复制筛选链接
		            </button>
                <a
                  href={exportChannelsTxtUrl}
	                  className="ui-btn ui-btn-secondary h-10"
                >
                  导出TXT
                </a>
                <a
                  href={exportChannelsJsonlUrl}
	                  className="ui-btn ui-btn-secondary h-10"
                >
                  导出JSONL
                </a>
                <button
                  type="button"
                  onClick={() => void copyChannelIdentifiers()}
                  disabled={loading}
	                  className="ui-btn ui-btn-secondary h-10"
                >
                  复制频道清单
                </button>
		          </div>
		        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 text-sm">
          <div>
            <label className="block text-sm font-medium">搜索（名称/标识/@username/id）</label>
            <input
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder="例如：@xxx / -100... / 频道名"
              className="ui-input mt-1"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">启用</label>
              <div className="mt-1">
                <Select
                  value={activeFilter}
                  onChange={(next) => setActiveFilter(next as typeof activeFilter)}
                  options={[
                    { value: "all", label: "全部" },
                    { value: "active", label: "仅启用" },
                    { value: "inactive", label: "仅停用" },
                  ]}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium">受保护</label>
              <div className="mt-1">
                <Select
                  value={protectedFilter}
                  onChange={(next) => setProtectedFilter(next as typeof protectedFilter)}
                  options={[
                    { value: "all", label: "全部" },
                    { value: "protected", label: "仅受保护" },
                    { value: "unprotected", label: "仅非受保护" },
                  ]}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium">解析</label>
              <div className="mt-1">
                <Select
                  value={resolvedFilter}
                  onChange={(next) => setResolvedFilter(next as typeof resolvedFilter)}
                  options={[
                    { value: "all", label: "全部" },
                    { value: "resolved", label: "仅已解析" },
                    { value: "unresolved", label: "仅未解析/未就绪" },
                  ]}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium">同步状态</label>
              <div className="mt-1">
                <Select
                  value={syncStatusFilter}
                  onChange={(next) => setSyncStatusFilter(next as typeof syncStatusFilter)}
                  options={[
                    { value: "all", label: "全部" },
                    { value: "pending", label: "pending" },
                    { value: "syncing", label: "syncing" },
                    { value: "completed", label: "completed" },
                    { value: "error", label: "error" },
                  ]}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium">分组</label>
              <div className="mt-1">
                <Select
                  value={groupFilter}
                  onChange={(next) => setGroupFilter(next)}
                  options={[
                    { value: "", label: "全部" },
                    ...(hasUngrouped ? [{ value: UNGROUPED, label: "未分组" }] : []),
                    ...groupOptions.map((g) => ({ value: g, label: g })),
                  ]}
                />
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white/50 p-4 text-sm dark:border-white/10 dark:bg-slate-900/40">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium">我的预设（保存到服务器）</div>
              <button
                type="button"
                onClick={() => saveCurrentAsPreset()}
                disabled={loading}
                className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
              >
                保存当前为预设
              </button>
            </div>

            {savedPresets.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {savedPresets.map((p) => (
                  <div key={p.id} className="inline-flex overflow-hidden rounded-xl border border-gray-200 bg-white/60 dark:border-white/10 dark:bg-slate-900/50">
                    <button
                      type="button"
                      onClick={() => applyPresetQueryString(p.query)}
                      disabled={loading}
                      className="inline-flex h-9 items-center justify-center px-3 text-xs text-gray-800 hover:bg-white/80 disabled:opacity-50 dark:text-slate-100 dark:hover:bg-white/10"
                      title={p.query}
                    >
                      {p.name}
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePreset(p.id)}
                      disabled={loading}
                      className="inline-flex h-9 items-center justify-center border-l border-gray-200 px-2 text-xs text-gray-500 hover:bg-white/80 disabled:opacity-50 dark:border-white/10 dark:text-slate-400 dark:hover:bg-white/10"
                      title="删除这个预设"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-2 text-xs text-gray-600 dark:text-slate-300">暂无预设：先把筛选条件调好，再点“保存当前为预设”。</div>
            )}

            <div className="mt-4 border-t border-white/20 dark:border-white/10 pt-4">
              <div className="font-medium">内置快捷</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNotice("");
                    setListQuery("");
                    setGroupFilter("");
                    setActiveFilter("all");
                    setProtectedFilter("all");
                    setResolvedFilter("all");
                    setSyncStatusFilter("error");
                    setSortBy("default");
                  }}
                  disabled={loading}
                  className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
                >
                  异常（error）
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNotice("");
                    setListQuery("");
                    setGroupFilter("");
                    setActiveFilter("all");
                    setProtectedFilter("all");
                    setResolvedFilter("unresolved");
                    setSyncStatusFilter("all");
                    setSortBy("default");
                  }}
                  disabled={loading}
                  className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
                >
                  未解析/未就绪
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNotice("");
                    setListQuery("");
                    setGroupFilter("");
                    setActiveFilter("all");
                    setProtectedFilter("protected");
                    setResolvedFilter("all");
                    setSyncStatusFilter("all");
                    setSortBy("default");
                  }}
                  disabled={loading}
                  className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
                >
                  受保护
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setNotice("");
                    setActiveFilter("inactive");
                    setListQuery("");
                    setGroupFilter("");
                    setProtectedFilter("all");
                    setResolvedFilter("all");
                    setSyncStatusFilter("all");
                    setSortBy("default");
                  }}
                  disabled={loading}
                  className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
                >
                  已停用
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="w-full md:w-64">
              <label className="block text-sm font-medium">排序</label>
              <div className="mt-1">
                <Select
                  value={sortBy}
                  onChange={(next) => setSortBy(next as typeof sortBy)}
                  options={[
                    { value: "default", label: "默认（订阅时间）" },
                    { value: "priority_desc", label: "优先级（高→低）" },
                    { value: "last_sync_desc", label: "最近同步（新→旧）" },
                    { value: "name_asc", label: "名称（A→Z）" },
                  ]}
                />
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setNotice("");
                setListQuery("");
                setGroupFilter("");
                setActiveFilter("all");
                setProtectedFilter("all");
                setResolvedFilter("all");
                setSyncStatusFilter("all");
                setSortBy("default");
                syncUrlToCurrentFilters();
              }}
              disabled={loading}
              className="ui-btn ui-btn-secondary h-10"
            >
              重置筛选
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-4">
          {visibleChannels.length ? (
            visibleChannels.map((c) => {
              const avatar = getAvatarText(c.name, c.channelIdentifier);
              const lastSync = formatRelativeTime(c.lastSyncAt);
              const statusLabel = c.isActive ? labelSyncStatus(c.syncStatus) : "暂停";

              const progressPct = (() => {
                if (c.tasks.history_full?.status === "completed") return 100;

                const fromTask = c.tasks.history_full
                  ? calcProgressPct(c.tasks.history_full.progressCurrent ?? 0, c.tasks.history_full.progressTotal ?? null)
                  : null;
                if (typeof fromTask === "number" && Number.isFinite(fromTask)) return Math.max(0, Math.min(100, fromTask));

                const total = c.messageStats.total;
                const fromStats = total > 0 ? (c.messageStats.success / total) * 100 : null;
                if (typeof fromStats === "number" && Number.isFinite(fromStats)) return Math.max(0, Math.min(100, fromStats));

                if (c.syncStatus.trim().toLowerCase() === "completed") return 100;
                return 0;
              })();

              const memberText = c.memberCount == null ? "-" : c.memberCount.toLocaleString("zh-CN");
              const messageText = (c.totalMessages ?? c.messageStats.total).toLocaleString("zh-CN");
              const title = c.name || c.channelIdentifier;
              const subtitle = c.username ? `@${c.username}` : c.channelIdentifier;

              return (
                <div key={c.id} className="glass-panel rounded-2xl p-6 hover-lift gradient-border">
                  <div className="flex items-start gap-4">
                    <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center text-white font-bold text-xl flex-shrink-0">
                      {avatar}
                    </div>

                    <div className="flex-1 min-w-0 space-y-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="text-xl font-semibold text-gray-900 dark:text-slate-100 truncate">{title}</h3>
                            {c.isProtected ? (
                              <span className="px-2 py-0.5 bg-orange-100 text-orange-700 text-xs rounded-full dark:bg-orange-500/15 dark:text-orange-200">
                                受保护
                              </span>
                            ) : null}
                            <span
                              className={clsx(
                                "px-2 py-0.5 text-xs rounded-full",
                                c.isActive ? "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-200" : "bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-slate-200",
                              )}
                            >
                              {c.isActive ? "活跃" : "暂停"}
                            </span>
                          </div>
                          <p className="text-gray-600 dark:text-slate-300 mt-1 truncate">{subtitle}</p>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => toggleActive(c)}
                            disabled={loading}
                            className="p-2 hover:bg-white/60 dark:hover:bg-slate-800/60 rounded-lg transition-all disabled:opacity-50"
                            title={c.isActive ? "暂停同步" : "启用同步"}
                          >
                            {c.isActive ? (
                              <Pause className="w-5 h-5 text-gray-600 dark:text-slate-300" />
                            ) : (
                              <Play className="w-5 h-5 text-green-600 dark:text-green-300" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteChannel(c)}
                            disabled={loading}
                            className="p-2 hover:bg-white/60 dark:hover:bg-slate-800/60 rounded-lg transition-all disabled:opacity-50"
                            title="删除频道"
                          >
                            <Trash2 className="w-5 h-5 text-red-600 dark:text-red-300" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-4">
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4 text-gray-400 dark:text-slate-400" />
                          <div>
                            <p className="text-sm text-gray-600 dark:text-slate-300">成员</p>
                            <p className="font-semibold text-gray-900 dark:text-slate-100">{memberText}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <MessageSquare className="w-4 h-4 text-gray-400 dark:text-slate-400" />
                          <div>
                            <p className="text-sm text-gray-600 dark:text-slate-300">消息</p>
                            <p className="font-semibold text-gray-900 dark:text-slate-100">{messageText}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 text-gray-400 dark:text-slate-400" />
                          <div>
                            <p className="text-sm text-gray-600 dark:text-slate-300">最后同步</p>
                            <p className="font-semibold text-gray-900 dark:text-slate-100">{lastSync}</p>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-600 dark:text-slate-300">{statusLabel}</span>
                          <span className="font-medium text-gray-900 dark:text-slate-100">{Math.round(progressPct)}%</span>
                        </div>
                        <div className="h-2 bg-gray-100 dark:bg-slate-800/60 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-blue-500 to-purple-600 rounded-full transition-all"
                            style={{ width: `${progressPct}%` }}
                          />
                        </div>
                      </div>

                      <a
                        href={`/channels/${c.id}`}
                        className="block w-full py-2 text-center bg-white/60 hover:bg-white border border-gray-200 rounded-xl font-medium text-gray-700 transition-all dark:bg-slate-900/50 dark:hover:bg-slate-900/70 dark:border-white/10 dark:text-slate-200"
                      >
                        查看详情
                      </a>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-6 text-center text-black/60 dark:text-slate-400">{channels.length ? "没有匹配的频道" : "暂无频道"}</div>
          )}
        </div>
      </div>
    </div>
  );
}
