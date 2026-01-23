"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";

type Dashboard = {
  channels: { total: number; active: number; protected: number };
  messages: { total: number; pending: number; success: number; failed: number; skipped: number };
  tasks: { total: number; pending: number; running: number; paused: number; completed: number; failed: number };
  runningTasks?: Array<{
    id: string;
    sourceChannelId: string;
    taskType: string;
    status: string;
    progressCurrent: number;
    progressTotal: number | null;
    lastProcessedId: number | null;
    lastError: string | null;
    createdAt: string;
    startedAt: string | null;
    source: {
      id: string;
      name: string;
      channelIdentifier: string;
      groupName: string;
      isActive: boolean;
      syncStatus: string;
    };
  }>;
  errorChannels?: Array<{
    id: string;
    name: string;
    channelIdentifier: string;
    groupName: string;
    syncStatus: string;
    isActive: boolean;
    isProtected: boolean;
    lastSyncAt: string | null;
    subscribedAt: string;
    lastErrorEvent:
      | {
          id: string;
          level: "info" | "warn" | "error";
          message: string;
          createdAt: string;
        }
      | null;
  }>;
  groups?: Array<{
    groupName: string;
    channels: { total: number; active: number; protected: number };
    tasks: { total: number; pending: number; running: number; paused: number; completed: number; failed: number };
  }>;
  mirrorService?: {
    online: boolean;
    lagSec: number | null;
    lastHeartbeatAt: string | null;
    startedAt: string | null;
    pid: number | null;
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

function formatTime(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN");
}

function buildGroupQuery(groupName: string): string {
  const params = new URLSearchParams();
  params.set("groupName", groupName);
  return params.toString();
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

export function DashboardSummary() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoRefreshMs, setAutoRefreshMs] = useState(1000);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recoveringId, setRecoveringId] = useState<string | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const loadingRef = useRef(false);
  const refreshingRef = useRef(false);

  const refresh = async () => {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = [json.error, json.cause].filter(Boolean).join("\n");
        throw new Error(details || "Failed to load dashboard");
      }
      setData(json as Dashboard);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const refreshSilently = async () => {
    setRefreshing(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/dashboard", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const details = [json.error, json.cause].filter(Boolean).join("\n");
        throw new Error(details || "Failed to load dashboard");
      }
      setData(json as Dashboard);
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
    refresh().catch(() => {});
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

  useEffect(() => {
    if (!autoRefresh) return;
    if (typeof EventSource === "undefined") return;

    const params = new URLSearchParams();
    params.set("status", "running");
    params.set("limit", "50");
    params.set("intervalMs", String(autoRefreshMs));
    const es = new EventSource(`/api/stream/tasks?${params.toString()}`);

    const onTasks = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as {
          tasks?: Array<{
            id: string;
            sourceChannelId: string;
            taskType: string;
            status: string;
            progressCurrent: number;
            progressTotal: number | null;
            lastProcessedId: number | null;
            lastError: string | null;
            createdAt: string;
            startedAt: string | null;
          }>;
        };
        if (!Array.isArray(payload.tasks)) return;

        const byId = new Map(payload.tasks.map((t) => [t.id, t]));

        setData((prev) => {
          if (!prev?.runningTasks?.length) return prev;
          return {
            ...prev,
            runningTasks: prev.runningTasks.map((t) => {
              const next = byId.get(t.id);
              if (!next) return t;
              return {
                ...t,
                status: next.status,
                progressCurrent: next.progressCurrent,
                progressTotal: next.progressTotal,
                lastProcessedId: next.lastProcessedId,
                lastError: next.lastError,
                createdAt: next.createdAt,
                startedAt: next.startedAt,
              };
            }),
          };
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
  }, [autoRefresh, autoRefreshMs]);

  const cards = useMemo(() => {
    const channels = data?.channels;
    const messages = data?.messages;
    const tasks = data?.tasks;
    const mirror = data?.mirrorService;
    const mirrorHint = mirror?.lastHeartbeatAt
      ? `last=${formatTime(mirror.lastHeartbeatAt)}${typeof mirror.lagSec === "number" ? ` · lag=${mirror.lagSec}s` : ""}`
      : "mirror-service";
    return [
      { label: "频道", value: channels ? `${channels.active}/${channels.total}` : "-", hint: "active/total" },
      { label: "受保护", value: channels ? String(channels.protected) : "-", hint: "protected" },
      { label: "消息", value: messages ? String(messages.total) : "-", hint: "total" },
      { label: "成功", value: messages ? String(messages.success) : "-", hint: "success" },
      { label: "失败", value: messages ? String(messages.failed) : "-", hint: "failed" },
      { label: "任务运行中", value: tasks ? String(tasks.running) : "-", hint: "running" },
      { label: "同步服务", value: mirror ? (mirror.online ? "在线" : "离线") : "-", hint: mirrorHint },
    ];
  }, [data]);

  const errorChannels = data?.errorChannels ?? [];
  const hasErrorChannels = errorChannels.length > 0;

  const recoverErrorChannel = async (args: { id: string; label: string }) => {
    if (!confirm(`确认恢复频道 ${args.label} 吗？这会把 syncStatus 从 error 改回 pending，并让 mirror-service 重新尝试执行任务。`)) {
      return;
    }
    setRecoveringId(args.id);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/channels", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: args.id, recoverSyncStatus: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to recover channel");
      setNotice("已恢复：syncStatus 已改为 pending，等待 mirror-service 重新调度。");
      await refreshSilently();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setRecoveringId(null);
    }
  };

  return (
    <div className="ui-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="ui-section-title">系统概览</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-slate-300">channels / messages / tasks</p>
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
            onClick={() => refresh()}
            disabled={loading}
            className="ui-btn ui-btn-secondary"
          >
            {loading ? "刷新中..." : refreshing ? "更新中..." : "刷新"}
          </button>
        </div>
      </div>

      {error ? <div className="ui-alert-error mt-4">{error}</div> : null}
      {notice ? (
        <div className="ui-alert-info mt-4">{notice}</div>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-gray-200 bg-white/50 p-4 dark:border-white/10 dark:bg-slate-900/40">
            <div className="text-gray-600 dark:text-slate-300">{c.label}</div>
            <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-slate-100">{c.value}</div>
            <div className="mt-1 text-xs text-gray-500 dark:text-slate-400">{c.hint}</div>
          </div>
        ))}
      </div>

      {data ? (
        <div className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-white/50 p-4 dark:border-white/10 dark:bg-slate-900/40">
            <div className="text-gray-600 dark:text-slate-300">消息状态</div>
            <div className="mt-1 text-xs text-gray-700 dark:text-slate-200">
              pending={data.messages.pending} · skipped={data.messages.skipped}
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white/50 p-4 dark:border-white/10 dark:bg-slate-900/40">
            <div className="text-gray-600 dark:text-slate-300">任务状态</div>
            <div className="mt-1 text-xs text-gray-700 dark:text-slate-200">
              pending={data.tasks.pending} · paused={data.tasks.paused} · failed={data.tasks.failed} · completed={data.tasks.completed}
            </div>
          </div>
        </div>
      ) : null}

      {data?.groups?.length ? (
        <div className="mt-4 rounded-2xl border border-gray-200 bg-white/50 p-5 text-sm dark:border-white/10 dark:bg-slate-900/40">
          <div className="font-medium text-gray-900 dark:text-slate-100">分组概览</div>
          <div className="mt-3 space-y-2">
            {data.groups.map((g) => {
              const rawName = (g.groupName ?? "").trim();
              const label = rawName ? rawName : "未分组";
              const qs = buildGroupQuery(rawName);
              return (
                <div
                  key={`${rawName || "__ungrouped__"}`}
                  className="rounded-xl border border-gray-200 bg-white/60 p-4 dark:border-white/10 dark:bg-slate-900/50"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 dark:text-slate-100">{label}</div>
                      <div className="mt-1 text-xs text-gray-600 dark:text-slate-300">
                        频道：{g.channels.active}/{g.channels.total} · protected={g.channels.protected}
                      </div>
                      <div className="mt-1 text-xs text-gray-600 dark:text-slate-300">
                        任务：running={g.tasks.running} · pending={g.tasks.pending} · paused={g.tasks.paused} · failed={g.tasks.failed}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={`/channels?${qs}`}
                        className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
                      >
                        频道
                      </a>
                      <a
                        href={`/messages?${qs}`}
                        className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
                      >
                        消息
                      </a>
                      <a
                        href={`/tasks?${qs}`}
                        className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
                      >
                        任务
                      </a>
                      <a
                        href={`/events?${qs}`}
                        className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
                      >
                        事件
                      </a>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 text-xs text-gray-500 dark:text-slate-400">
            提示：点击上面的“频道/消息/任务/事件”会带上该分组过滤条件。
          </div>
        </div>
      ) : null}

      {data ? (
        <div
          className={`mt-4 rounded-2xl border p-5 text-sm ${
            hasErrorChannels
              ? "border-red-200 bg-red-50/60 dark:border-red-500/30 dark:bg-red-500/10"
              : "border-gray-200 bg-white/50 dark:border-white/10 dark:bg-slate-900/40"
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div
              className={
                hasErrorChannels
                  ? "font-medium text-red-800 dark:text-red-200"
                  : "font-medium text-gray-900 dark:text-slate-100"
              }
            >
              异常频道（syncStatus=error）
            </div>
            <a href="/channels" className="text-xs text-blue-700 hover:underline">
              去频道管理查看
            </a>
          </div>

          {hasErrorChannels ? (
            <>
              <div className="mt-2 text-xs text-red-800/80">
                提示：处于 error 的频道会被 mirror-service 暂时跳过（避免反复失败占用并发）。
              </div>

              <div className="mt-3 space-y-2">
                {errorChannels.map((c) => {
                  const groupLabel = (c.groupName ?? "").trim() ? c.groupName.trim() : "未分组";
                  const err = c.lastErrorEvent;
                  return (
                    <div key={c.id} className="rounded-xl border border-red-200 bg-white/70 p-4 dark:border-red-500/30 dark:bg-red-500/10">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-red-900 dark:text-red-100">{c.name}</div>
                          <div className="mt-1 text-xs text-red-900/70 dark:text-red-200/80">{groupLabel}</div>
                          <div className="mt-1 text-xs text-red-900/60 dark:text-red-200/70">{c.channelIdentifier}</div>
                          {err ? (
                            <div className="mt-2 text-xs text-red-800 dark:text-red-200 whitespace-pre-wrap">
                              最近错误（{formatTime(err.createdAt)}）：{truncateText(err.message, 160)}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <a
                            href={`/channels/${encodeURIComponent(c.id)}`}
                            className="ui-btn h-9 px-3 text-xs border border-red-200 bg-white/60 text-red-900 hover:bg-red-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100 dark:hover:bg-red-500/15"
                          >
                            频道详情
                          </a>
                          <a
                            href={`/events?sourceChannelId=${encodeURIComponent(c.id)}&level=error`}
                            className="ui-btn h-9 px-3 text-xs border border-red-200 bg-white/60 text-red-900 hover:bg-red-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100 dark:hover:bg-red-500/15"
                          >
                            错误事件
                          </a>
                          <button
                            type="button"
                            onClick={() => recoverErrorChannel({ id: c.id, label: c.channelIdentifier })}
                            disabled={loading || refreshing || recoveringId === c.id}
                            className="ui-btn h-9 px-3 text-xs border border-red-200 bg-white text-red-900 hover:bg-red-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100 dark:hover:bg-red-500/15"
                          >
                            {recoveringId === c.id ? "恢复中..." : "恢复"}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="mt-2 text-xs text-gray-600 dark:text-slate-300">暂无异常频道（目前没有 syncStatus=error 的频道）。</div>
          )}
        </div>
      ) : null}

      {data ? (
        <div className="mt-4 rounded-2xl border border-gray-200 bg-white/50 p-5 text-sm dark:border-white/10 dark:bg-slate-900/40">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="font-medium text-gray-900 dark:text-slate-100">正在运行的任务</div>
            <a href="/tasks?status=running" className="text-xs text-blue-700 hover:underline">
              去任务页查看
            </a>
          </div>

          {data.runningTasks?.length ? (
            <div className="mt-3 space-y-2">
              {data.runningTasks.map((t) => {
                const groupLabel = (t.source.groupName ?? "").trim() ? t.source.groupName.trim() : "未分组";
                const pct = calcProgressPct(t.progressCurrent, t.progressTotal);
                return (
                  <div key={t.id} className="rounded-xl border border-gray-200 bg-white/60 p-4 dark:border-white/10 dark:bg-slate-900/50">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 dark:text-slate-100">{t.source.name}</div>
                        <div className="mt-1 text-xs text-gray-600 dark:text-slate-300">
                          {groupLabel} · {t.taskType} · {t.progressCurrent}/{t.progressTotal ?? "-"}
                          {t.lastProcessedId != null ? ` · lastId=${t.lastProcessedId}` : ""}
                        </div>
                        <div className="mt-1 text-xs text-gray-500 dark:text-slate-400">{t.source.channelIdentifier}</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <a
                          href={`/channels/${encodeURIComponent(t.source.id)}`}
                          className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
                        >
                          频道详情
                        </a>
                        <a
                          href={`/tasks?sourceChannelId=${encodeURIComponent(t.source.id)}`}
                          className="ui-btn ui-btn-secondary h-9 px-3 text-xs"
                        >
                          任务
                        </a>
                      </div>
                    </div>

                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/60 border border-white/20 dark:bg-slate-900/40 dark:border-white/10">
                      <div
                        className={`h-full ${pct == null ? "bg-blue-400/40 animate-pulse" : "bg-gradient-to-r from-blue-500 to-purple-600"}`}
                        style={{ width: `${pct ?? 33}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-3 text-sm text-gray-600 dark:text-slate-300">暂无运行中的任务</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
