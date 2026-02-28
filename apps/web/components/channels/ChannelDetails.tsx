"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { EventsFeed } from "@/components/events/EventsFeed";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { buildTelegramChannelLink } from "@/lib/telegram-links";
import { calcProgressPct, formatTime, getErrorMessage } from "@/lib/utils";

type MirrorMode = "forward" | "copy";
type MessageFilterMode = "inherit" | "disabled" | "custom";

type TaskStatus = "pending" | "running" | "paused" | "completed" | "failed";
type TaskType = "resolve" | "history_full" | "history_partial" | "realtime" | "retry_failed";
type TaskAction = "pause" | "resume" | "requeue" | "restart";

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
  messageFilterMode: MessageFilterMode;
  messageFilterKeywords: string;
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

function truncateText(value: string, maxLen: number): string {
  const text = value.trim();
  if (!text) return "(空)";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

export function ChannelDetails({ channelId }: { channelId: string }) {
  const [channel, setChannel] = useState<ChannelRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoRefreshMs, setAutoRefreshMs] = useState(1000);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mirrorModeDraft, setMirrorModeDraft] = useState<MirrorMode>("forward");
  const [mirrorModeDirty, setMirrorModeDirty] = useState(false);
  const [priorityDraft, setPriorityDraft] = useState("");
  const [priorityDirty, setPriorityDirty] = useState(false);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupNameDirty, setGroupNameDirty] = useState(false);
  const [messageFilterModeDraft, setMessageFilterModeDraft] = useState<MessageFilterMode>("inherit");
  const [messageFilterModeDirty, setMessageFilterModeDirty] = useState(false);
  const [messageFilterKeywordsDraft, setMessageFilterKeywordsDraft] = useState("");
  const [messageFilterKeywordsDirty, setMessageFilterKeywordsDirty] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const loadingRef = useRef(false);
  const refreshingRef = useRef(false);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/channels?id=${encodeURIComponent(channelId)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load channels");
      const rows = (data.channels ?? []) as ChannelRow[];
      const found = rows.find((c) => c.id === channelId) ?? null;
      setChannel(found);
      if (found?.mirrorMode && !mirrorModeDirty) setMirrorModeDraft(found.mirrorMode);
      if (found && !priorityDirty) setPriorityDraft(String(found.priority ?? 0));
      if (found && !groupNameDirty) setGroupNameDraft(found.groupName ?? "");
      if (found && !messageFilterModeDirty) setMessageFilterModeDraft(found.messageFilterMode ?? "inherit");
      if (found && !messageFilterKeywordsDirty) setMessageFilterKeywordsDraft(found.messageFilterKeywords ?? "");
      if (!found) setError("频道不存在或已删除");
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const refreshSilently = async () => {
    setRefreshing(true);
    setError("");
    try {
      const res = await fetch(`/api/channels?id=${encodeURIComponent(channelId)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load channels");
      const rows = (data.channels ?? []) as ChannelRow[];
      const found = rows.find((c) => c.id === channelId) ?? null;
      setChannel(found);
      if (found?.mirrorMode && !mirrorModeDirty) setMirrorModeDraft(found.mirrorMode);
      if (found && !priorityDirty) setPriorityDraft(String(found.priority ?? 0));
      if (found && !groupNameDirty) setGroupNameDraft(found.groupName ?? "");
      if (found && !messageFilterModeDirty) setMessageFilterModeDraft(found.messageFilterMode ?? "inherit");
      if (found && !messageFilterKeywordsDirty) setMessageFilterKeywordsDraft(found.messageFilterKeywords ?? "");
      if (!found) setError("频道不存在或已删除");
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
    setMirrorModeDirty(false);
    setPriorityDirty(false);
    setGroupNameDirty(false);
    setMessageFilterModeDirty(false);
    setMessageFilterKeywordsDirty(false);
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (loadingRef.current || refreshingRef.current) return;
      void refreshRef.current().catch(() => {});
    }, autoRefreshMs);
    return () => window.clearInterval(id);
  }, [autoRefresh, autoRefreshMs, channelId]);

  useEffect(() => {
    if (!autoRefresh) return;
    if (typeof EventSource === "undefined") return;

    const params = new URLSearchParams();
    params.set("sourceChannelId", channelId);
    params.set("limit", "200");
    params.set("intervalMs", String(autoRefreshMs));
    const es = new EventSource(`/api/stream/tasks?${params.toString()}`);

    const onTasks = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as {
          tasks?: Array<{
            id: string;
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
        const tasks = payload.tasks;

        setChannel((prev) => {
          if (!prev) return prev;

          const byType: Partial<Record<TaskType, TaskSummary>> = {};
          for (const t of tasks) {
            const type = t.taskType;
            if (byType[type]) continue;
            byType[type] = {
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

          return { ...prev, tasks: { ...prev.tasks, ...byType } };
        });
      } catch {
        // ignore
      }
    };

    es.addEventListener("tasks", onTasks as EventListener);

    return () => {
      es.removeEventListener("tasks", onTasks as EventListener);
      es.close();
    };
  }, [autoRefresh, autoRefreshMs, channelId]);

  const sourceChannelLink = useMemo(() => {
    if (!channel) return null;
    return buildTelegramChannelLink({
      username: channel.username,
      telegramId: channel.telegramId,
      anchorMessageId: channel.lastMessageId ?? 1,
    });
  }, [channel]);

  const mirrorChannelLink = useMemo(() => {
    if (!channel?.mirrorChannel) return null;
    return buildTelegramChannelLink({
      username: channel.mirrorChannel.username,
      telegramId: channel.mirrorChannel.telegramId,
    });
  }, [channel?.mirrorChannel]);

  const exportMessagesLink = useMemo(() => {
    if (!channel) return null;
    const params = new URLSearchParams({ sourceChannelId: channel.id, groupMedia: "true" });
    return `/api/export/messages?${params.toString()}`;
  }, [channel]);

  const toggleActive = async () => {
    if (!channel) return;
    setLoading(true);
    setError("");
    setNotice("");
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

  const deleteChannel = async () => {
    if (!channel) return;
    if (!confirm(`确认删除频道 ${channel.channelIdentifier} 吗？这会清空该频道的任务与消息映射记录。`)) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/channels", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to delete channel");
      window.location.href = "/channels";
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const updateTask = async (taskId: string, action: TaskAction) => {
    if (!taskId) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: taskId, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to update task");
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const renderTaskActions = (task: TaskSummary | undefined) => {
    if (!task) return null;
    return (
      <div className="flex flex-wrap gap-2 pt-2">
        {task.status === "paused" ? (
          <button
            type="button"
            onClick={() => updateTask(task.id, "resume")}
            disabled={loading}
            className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
          >
            恢复
          </button>
        ) : (
          <button
            type="button"
            onClick={() => updateTask(task.id, "pause")}
            disabled={loading || task.status === "completed" || task.status === "failed"}
            className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
          >
            暂停
          </button>
        )}
        <button
          type="button"
          onClick={() => updateTask(task.id, "requeue")}
          disabled={loading || task.status === "running" || task.status === "paused"}
          className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
        >
          重排队
        </button>
        <button
          type="button"
          onClick={() => updateTask(task.id, "restart")}
          disabled={loading || task.status === "running"}
          className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
        >
          重启
        </button>
      </div>
    );
  };

  const retryFailedMessages = async () => {
    if (!channel) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/tasks/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: channel.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create retry task");
      if (typeof data.message === "string" && data.message.trim()) setNotice(data.message.trim());
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const saveMirrorMode = async () => {
    if (!channel) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id, mirrorMode: mirrorModeDraft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update mirror mode");
      setNotice("镜像方式已更新（对后续同步生效）");
      setMirrorModeDirty(false);
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const saveMessageFilter = async () => {
    if (!channel) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: channel.id,
          messageFilterMode: messageFilterModeDraft,
          messageFilterKeywords: messageFilterKeywordsDraft,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update message filter");
      setNotice("该频道过滤已更新（约 5 秒内生效）");
      setMessageFilterModeDirty(false);
      setMessageFilterKeywordsDirty(false);
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const savePriority = async () => {
    if (!channel) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const raw = priorityDraft.trim();
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

      setNotice("优先级已更新");
      setPriorityDirty(false);
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const saveGroupName = async () => {
    if (!channel) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const raw = groupNameDraft.trim();
      const groupName = raw.slice(0, 50);

      const res = await fetch("/api/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id, groupName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to update group name");

      setNotice("分组已更新");
      setGroupNameDirty(false);
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const recoverChannelSyncStatus = async () => {
    if (!channel) return;
    if (!confirm("确认恢复该频道吗？这会把 syncStatus 从 error 改回 pending，并让 mirror-service 重新尝试执行任务。")) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.id, recoverSyncStatus: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to recover channel");
      setNotice("已恢复：syncStatus 已改为 pending，等待 mirror-service 重新调度。");
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
              频道详情
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">{channel ? channel.name : channelId}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/channels"
              className="ui-btn ui-btn-secondary h-10"
            >
              返回频道列表
            </Link>
            <Link
              href={channel ? `/messages?sourceChannelId=${encodeURIComponent(channel.id)}` : "/messages"}
              className="ui-btn ui-btn-secondary h-10"
            >
              查看消息
            </Link>
            <Link
              href={channel ? `/events?sourceChannelId=${encodeURIComponent(channel.id)}` : "/events"}
              className="ui-btn ui-btn-secondary h-10"
            >
              事件中心
            </Link>
            <button
              type="button"
              onClick={() => refresh()}
              disabled={loading}
              className="ui-btn ui-btn-secondary h-10"
            >
              {loading ? "刷新中..." : refreshing ? "更新中..." : "刷新"}
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
      </div>

      {channel ? (
        <>
          <div className="ui-card">
            <h2 className="ui-section-title">基本信息</h2>
            <div className="mt-4 grid grid-cols-1 gap-4 text-sm">
              <div>
                <div className="text-gray-600 dark:text-slate-300">源频道</div>
                <div className="mt-1 font-medium">{channel.channelIdentifier}</div>
                <div className="mt-1 text-xs text-gray-600 dark:text-slate-300">
                  telegramId={channel.telegramId ?? "-"} {channel.username ? `· @${channel.username}` : ""}
                </div>
                <div className="mt-1 text-xs text-gray-600 dark:text-slate-300">
                  members={channel.memberCount ?? "-"} · totalMessages={channel.totalMessages ?? "-"}
                </div>
                {channel.description ? (
                  <div className="mt-2 text-xs whitespace-pre-wrap text-gray-600 dark:text-slate-300">{channel.description}</div>
                ) : null}
                {sourceChannelLink ? (
                  <div className="mt-2">
                    <a
                      href={sourceChannelLink}
                      target="_blank"
                      rel="noreferrer"
                      className="ui-btn ui-btn-secondary h-9 px-3 text-sm"
                    >
                      打开源频道
                    </a>
                  </div>
                ) : null}
              </div>
              <div>
                <div className="text-gray-600 dark:text-slate-300">镜像频道</div>
                {channel.mirrorChannel ? (
                  <>
                    <div className="mt-1 font-medium">{channel.mirrorChannel.channelIdentifier}</div>
                    <div className="mt-1 text-xs text-gray-600 dark:text-slate-300">
                      telegramId={channel.mirrorChannel.telegramId ?? "-"}{" "}
                      {channel.mirrorChannel.username ? `· @${channel.mirrorChannel.username}` : ""}
                    </div>
                    {mirrorChannelLink ? (
                      <div className="mt-2">
                        <a
                          href={mirrorChannelLink}
                          target="_blank"
                          rel="noreferrer"
                          className="ui-btn ui-btn-secondary h-9 px-3 text-sm"
                        >
                          打开镜像频道
                        </a>
                      </div>
                    ) : null}
                    {channel.mirrorChannel.inviteLink ? (
                      <div className="mt-2">
                        <a
                          href={channel.mirrorChannel.inviteLink}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-9 items-center justify-center rounded-md border border-black/10 bg-white px-3 text-sm text-gray-900 hover:bg-black/5 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                        >
                          打开邀请链接
                        </a>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="mt-1 text-black/60 dark:text-slate-400">-</div>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <div className="text-black/60 dark:text-slate-300">同步</div>
                  <div className="mt-1">
                    status={channel.syncStatus} · lastSyncAt={formatTime(channel.lastSyncAt)}
                  </div>
                  <div className="mt-1 text-xs text-black/60 dark:text-slate-400">lastMessageId={channel.lastMessageId ?? "-"}</div>
                  {channel.syncStatus === "error" && channel.lastErrorEvent ? (
                    <div className="mt-2 text-xs text-red-700 dark:text-red-200 whitespace-pre-wrap">
                      最近错误（{formatTime(channel.lastErrorEvent.createdAt)}）：{truncateText(channel.lastErrorEvent.message, 180)}
                    </div>
                  ) : channel.lastEvent ? (
                    <div className="mt-2 text-xs text-black/60 dark:text-slate-400 whitespace-pre-wrap">
                      最近事件（{channel.lastEvent.level} · {formatTime(channel.lastEvent.createdAt)}）：{truncateText(channel.lastEvent.message, 180)}
                    </div>
                  ) : null}
                  {channel.syncStatus === "error" ? (
                    <div className="mt-1 text-xs">
                      <a
                        href={`/events?sourceChannelId=${encodeURIComponent(channel.id)}&level=error`}
                        className="text-blue-700 hover:underline dark:text-blue-300"
                      >
                        查看错误事件
                      </a>
                    </div>
                  ) : null}
                  {channel.syncStatus === "error" ? (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={recoverChannelSyncStatus}
                        disabled={loading}
                        className="inline-flex h-9 items-center justify-center rounded-md border border-red-200 bg-red-50 px-3 text-sm text-red-800 hover:bg-red-100 disabled:opacity-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/15"
                      >
                        恢复（重新尝试）
                      </button>
                    </div>
                  ) : null}
                </div>
                <div>
                  <div className="text-black/60 dark:text-slate-300">策略</div>
	                  <div className="mt-1">
	                    mode={channel.mirrorMode ?? "-"} · protected={channel.isProtected ? "yes" : "no"} · active=
	                    {channel.isActive ? "yes" : "no"} · priority={channel.priority ?? 0} · filter=
	                    {channel.messageFilterMode ?? "inherit"} · group=
	                    {(channel.groupName ?? "").trim() ? channel.groupName.trim() : "未分组"}
	                  </div>
	                  {channel.isProtected ? (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                      提示：该源频道开启了“保护内容/禁止转发”，Telegram 会阻止转发/备份，所以镜像频道里可能看不到新消息。
                      你可以去 /settings 勾选“跳过禁止转发的频道消息”，让任务继续跑但把这些消息标记为 skipped；或者取消勾选，让任务在遇到该限制时暂停。
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-md border border-black/10 bg-white p-4 text-sm dark:border-white/10 dark:bg-white/5">
              <div className="font-medium">分组与优先级</div>
              <div className="mt-2 flex flex-wrap items-end gap-3">
                <div>
                  <div className="text-xs text-black/60 dark:text-slate-400">分组（空=未分组）</div>
                  <input
                    type="text"
                    value={groupNameDraft}
                    onChange={(e) => {
                      setGroupNameDraft(e.target.value);
                      setGroupNameDirty(true);
                    }}
                    placeholder="例如：重要/娱乐"
                    className="mt-1 h-10 w-48 rounded-md border border-black/10 bg-white px-3 text-sm text-gray-900 outline-none focus:border-black/30 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:focus:border-white/20"
                  />
                </div>
                <button
                  type="button"
                  onClick={saveGroupName}
                  disabled={loading || groupNameDraft.trim().slice(0, 50) === (channel.groupName ?? "")}
                  className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  保存分组
                </button>

                <div>
                  <div className="text-xs text-black/60 dark:text-slate-400">优先级（-100~100）</div>
                  <input
                    type="number"
                    value={priorityDraft}
                    onChange={(e) => {
                      setPriorityDraft(e.target.value);
                      setPriorityDirty(true);
                    }}
                    className="mt-1 h-10 w-28 rounded-md border border-black/10 bg-white px-3 text-sm text-gray-900 outline-none focus:border-black/30 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:focus:border-white/20"
                  />
                </div>
                <button
                  type="button"
                  onClick={savePriority}
                  disabled={(() => {
                    if (loading) return true;
                    const raw = priorityDraft.trim();
                    const parsed = raw ? Number.parseInt(raw, 10) : 0;
                    if (!Number.isFinite(parsed)) return true;
                    const clamped = Math.max(-100, Math.min(100, Math.trunc(parsed)));
                    return clamped === (channel.priority ?? 0);
                  })()}
                  className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  保存优先级
                </button>
              </div>
              <div className="mt-2 text-xs text-black/60 dark:text-slate-400">
                提示：优先级越大，mirror-service 越倾向先处理这个频道的 pending 任务（比如设 10）。
              </div>
            </div>

	            <div className="mt-4 rounded-md border border-black/10 bg-white p-4 text-sm dark:border-white/10 dark:bg-white/5">
	              <div className="font-medium">镜像方式</div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <div className="min-w-[220px]">
                  <Select
                    value={mirrorModeDraft}
                    onChange={(next) => {
                      setMirrorModeDraft(next as MirrorMode);
                      setMirrorModeDirty(true);
                    }}
                    disabled={loading}
                    options={[
                      { value: "forward", label: "forward（转发）" },
                      { value: "copy", label: "copy（复制，无署名）" },
                    ]}
                  />
                </div>
                <button
                  type="button"
                  onClick={saveMirrorMode}
                  disabled={loading || !channel || mirrorModeDraft === (channel.mirrorMode ?? "forward")}
                  className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  保存镜像方式
                </button>
              </div>
	              <div className="mt-2 text-xs text-black/60 dark:text-slate-400">
	                提示：修改后只影响“之后同步”的消息；已经备份到镜像频道里的历史消息不会自动重发/重排。
	              </div>
	            </div>

            <div className="mt-4 rounded-md border border-black/10 bg-white p-4 text-sm dark:border-white/10 dark:bg-white/5">
              <div className="font-medium">广告过滤（该频道）</div>
              <div className="mt-2 flex flex-wrap items-end gap-3">
                <div>
                  <div className="text-xs text-black/60 dark:text-slate-400">模式</div>
                  <div className="mt-1 min-w-[260px]">
                    <Select
                      value={messageFilterModeDraft}
                      onChange={(next) => {
                        setMessageFilterModeDraft(next as MessageFilterMode);
                        setMessageFilterModeDirty(true);
                      }}
                      disabled={loading}
                      options={[
                        { value: "inherit", label: "inherit（跟随全局 /settings）" },
                        { value: "disabled", label: "disabled（该频道关闭过滤）" },
                        { value: "custom", label: "custom（该频道自定义关键词）" },
                      ]}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={saveMessageFilter}
                  disabled={
                    loading ||
                    !channel ||
                    (!messageFilterModeDirty && !messageFilterKeywordsDirty) ||
                    (messageFilterModeDraft === (channel.messageFilterMode ?? "inherit") &&
                      messageFilterKeywordsDraft.trim() === (channel.messageFilterKeywords ?? "").trim())
                  }
                  className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  保存过滤设置
                </button>
              </div>

              {messageFilterModeDraft === "custom" ? (
                <div className="mt-3">
                  <div className="text-xs text-black/60 dark:text-slate-400">关键词（建议每行一个）</div>
                  <textarea
                    value={messageFilterKeywordsDraft}
                    onChange={(e) => {
                      setMessageFilterKeywordsDraft(e.target.value);
                      setMessageFilterKeywordsDirty(true);
                    }}
                    rows={4}
                    placeholder={"广告\n加群\nVX"}
                    className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-black/30 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:focus:border-white/20"
                  />
                </div>
              ) : null}

              <div className="mt-2 text-xs text-black/60 dark:text-slate-400">
                说明：命中关键词的消息会被跳过（skipped=filtered），不会发送到镜像频道。
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={toggleActive}
                disabled={loading}
                className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                {loading ? "处理中..." : channel.isActive ? "停用同步" : "启用同步"}
              </button>
              {exportMessagesLink ? (
                <a
                  href={exportMessagesLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
                >
                  导出消息(JSONL)
                </a>
              ) : null}
              <button
                type="button"
                onClick={deleteChannel}
                disabled={loading}
                className="inline-flex h-10 items-center justify-center rounded-md border border-red-200 bg-red-50 px-4 text-sm text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200 dark:hover:bg-red-500/15"
              >
                {loading ? "处理中..." : "删除频道"}
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-black/10 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-900/40">
            <h2 className="text-base font-semibold">任务与进度</h2>
            <div className="mt-4 space-y-3 text-sm">
              <div>
                resolve: {channel.tasks.resolve?.status ?? "-"}{" "}
                {channel.tasks.resolve?.lastError ? (
                  <span className="text-red-700 dark:text-red-200">· {channel.tasks.resolve.lastError}</span>
                ) : null}
                {renderTaskActions(channel.tasks.resolve)}
              </div>
	              <div>
	                history_full: {channel.tasks.history_full?.status ?? "-"}
	                {channel.tasks.history_full ? (
	                  <span className="text-black/60 dark:text-slate-400">
	                    {" "}
	                    · progress={channel.tasks.history_full.progressCurrent ?? 0}/{channel.tasks.history_full.progressTotal ?? "-"} · lastId=
	                    {channel.tasks.history_full.lastProcessedId ?? "-"}
	                  </span>
	                ) : null}
	                {channel.tasks.history_full
	                  ? (() => {
	                      const show =
	                        channel.tasks.history_full.status === "running" ||
	                        channel.tasks.history_full.status === "pending" ||
	                        channel.tasks.history_full.status === "paused";
	                      if (!show) return null;
	                      const pct = calcProgressPct(
	                        channel.tasks.history_full.progressCurrent ?? 0,
	                        channel.tasks.history_full.progressTotal ?? null,
	                      );
	                      return (
	                        <div className="mt-2 max-w-sm">
	                          <div className="h-2 w-full overflow-hidden rounded bg-black/10 dark:bg-white/10">
	                            <div
	                              className={`h-full ${pct == null ? "bg-black/30 animate-pulse dark:bg-white/30" : "bg-black/40 dark:bg-white/40"}`}
	                              style={{ width: `${pct ?? 33}%` }}
	                            />
	                          </div>
	                        </div>
	                      );
	                    })()
	                  : null}
	                {channel.tasks.history_full?.lastError ? (
	                  <div className="mt-1 text-xs text-red-700 dark:text-red-200 whitespace-pre-wrap">{channel.tasks.history_full.lastError}</div>
	                ) : null}
	                {renderTaskActions(channel.tasks.history_full)}
	              </div>
              <div>
                realtime: {channel.tasks.realtime?.status ?? "-"}{" "}
                {channel.tasks.realtime?.lastError ? (
                  <span className="text-red-700 dark:text-red-200">· {channel.tasks.realtime.lastError}</span>
                ) : null}
                {renderTaskActions(channel.tasks.realtime)}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-black/10 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-slate-900/40">
            <h2 className="text-base font-semibold">消息统计</h2>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
              <div className="rounded-md border border-black/10 p-3 dark:border-white/10">
                <div className="text-black/60 dark:text-slate-400">total</div>
                <div className="mt-1 text-lg font-semibold">{channel.messageStats.total}</div>
              </div>
              <div className="rounded-md border border-black/10 p-3 dark:border-white/10">
                <div className="text-black/60 dark:text-slate-400">success</div>
                <div className="mt-1 text-lg font-semibold">{channel.messageStats.success}</div>
              </div>
              <div className="rounded-md border border-black/10 p-3 dark:border-white/10">
                <div className="text-black/60 dark:text-slate-400">pending</div>
                <div className="mt-1 text-lg font-semibold">{channel.messageStats.pending}</div>
              </div>
              <div className="rounded-md border border-black/10 p-3 dark:border-white/10">
                <div className="text-black/60 dark:text-slate-400">failed</div>
                <div className="mt-1 text-lg font-semibold">{channel.messageStats.failed}</div>
              </div>
              <div className="rounded-md border border-black/10 p-3 dark:border-white/10">
                <div className="text-black/60 dark:text-slate-400">skipped</div>
                <div className="mt-1 text-lg font-semibold">{channel.messageStats.skipped}</div>
              </div>
              <div className="rounded-md border border-black/10 p-3 dark:border-white/10">
                <div className="text-black/60 dark:text-slate-400">skipped protected</div>
                <div className="mt-1 text-lg font-semibold">{channel.messageStats.skippedProtectedContent}</div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href={`/messages?sourceChannelId=${encodeURIComponent(channel.id)}&status=failed`}
                className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                查看 failed
              </a>
              <a
                href={`/messages?sourceChannelId=${encodeURIComponent(channel.id)}&status=skipped`}
                className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                查看 skipped
              </a>
              <button
                type="button"
                onClick={retryFailedMessages}
                disabled={
                  loading ||
                  !channel.isActive ||
                  channel.messageStats.failed <= 0 ||
                  channel.tasks.history_full?.status === "pending" ||
                  channel.tasks.history_full?.status === "running"
                }
                className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm text-gray-900 hover:bg-black/5 disabled:opacity-50 dark:border-white/10 dark:bg-slate-900/40 dark:text-slate-100 dark:hover:bg-white/10"
              >
                重试 failed（创建任务）
              </button>
            </div>
          </div>

          <EventsFeed title="该频道最近事件" sourceChannelId={channel.id} limit={30} />
        </>
      ) : null}
    </div>
  );
}
