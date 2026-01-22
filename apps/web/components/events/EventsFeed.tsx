"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { AlertCircle, Clock, Info, XCircle } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";

type EventLevel = "info" | "warn" | "error";

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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN");
}

const iconMap: Record<EventLevel, typeof Info> = {
  info: Info,
  warn: AlertCircle,
  error: XCircle,
};

const colorMap: Record<EventLevel, { bg: string; text: string; icon: string; border: string }> = {
  info: {
    bg: "bg-blue-50",
    text: "text-blue-700",
    icon: "text-blue-500",
    border: "border-blue-200",
  },
  warn: {
    bg: "bg-orange-50",
    text: "text-orange-700",
    icon: "text-orange-500",
    border: "border-orange-200",
  },
  error: {
    bg: "bg-red-50",
    text: "text-red-700",
    icon: "text-red-500",
    border: "border-red-200",
  },
};

export function EventsFeed({
  title = "最近事件",
  sourceChannelId,
  limit = 50,
}: {
  title?: string;
  sourceChannelId?: string;
  limit?: number;
}) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoRefreshMs, setAutoRefreshMs] = useState(5000);
  const [error, setError] = useState("");
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const loadingRef = useRef(false);
  const refreshingRef = useRef(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (sourceChannelId) params.set("sourceChannelId", sourceChannelId);
    params.set("limit", String(limit));
    return params.toString();
  }, [sourceChannelId, limit]);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/events?${query}`, { cache: "no-store" });
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

  const refreshSilently = async () => {
    setRefreshing(true);
    setError("");
    try {
      const res = await fetch(`/api/events?${query}`, { cache: "no-store" });
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

  refreshRef.current = refreshSilently;
  loadingRef.current = loading;
  refreshingRef.current = refreshing;

  useEffect(() => {
    refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (loadingRef.current || refreshingRef.current) return;
      void refreshRef.current().catch(() => {});
    }, autoRefreshMs);
    return () => window.clearInterval(id);
  }, [autoRefresh, autoRefreshMs, query]);

  return (
    <div className="ui-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="ui-section-title">{title}</h2>
          <p className="mt-1 text-sm text-gray-600">sync_events（仅记录关键事件，不会按消息刷屏）。</p>
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
            className="ui-btn ui-btn-secondary"
          >
            {loading ? "刷新中..." : refreshing ? "更新中..." : "刷新"}
          </button>
        </div>
      </div>

      {error ? <div className="ui-alert-error mt-4">{error}</div> : null}

      <div className="mt-4 space-y-3">
        {!events.length ? (
          <div className="text-sm text-gray-600">{loading ? "加载中..." : "暂无事件"}</div>
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
                        <h3 className="font-semibold text-gray-900">{title}</h3>
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
                      {detail ? <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{detail}</p> : null}
                    </div>

                    <div className="flex items-center gap-4 text-xs text-gray-500">
                      <span className="font-medium text-gray-700">{channelText}</span>
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
  );
}
