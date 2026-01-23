"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Copy, FileText, RefreshCw } from "lucide-react";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";

type LogsResponse =
  | {
      enabled: false;
      error?: string;
    }
  | {
      enabled: true;
      configuredPath: string;
      filePath: string;
      limit: number;
      truncated: boolean;
      sizeBytes: number;
      updatedAt: string | null;
      lines: string[];
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

function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("zh-CN");
}

export function LogsManager() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [configuredPath, setConfiguredPath] = useState("");
  const [filePath, setFilePath] = useState("");
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  const [limit, setLimit] = useState(200);
  const [filter, setFilter] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoRefreshMs, setAutoRefreshMs] = useState(5000);

  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/logs?limit=${encodeURIComponent(String(limit))}`, { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as LogsResponse & { error?: string };
      if (!res.ok) throw new Error(json.error || "Failed to load logs");

      if (!json.enabled) {
        setEnabled(false);
        setLines([]);
        setTruncated(false);
        setConfiguredPath("");
        setFilePath("");
        setSizeBytes(null);
        setUpdatedAt(null);
        if (json.error) setError(json.error);
        return;
      }

      setEnabled(true);
      setConfiguredPath(json.configuredPath);
      setFilePath(json.filePath);
      setSizeBytes(json.sizeBytes);
      setUpdatedAt(json.updatedAt);
      setTruncated(json.truncated);
      setLines(Array.isArray(json.lines) ? json.lines : []);
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
  }, [limit]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => void refreshRef.current(), autoRefreshMs);
    return () => window.clearInterval(id);
  }, [autoRefresh, autoRefreshMs]);

  const visibleLines = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return lines;
    return lines.filter((l) => l.toLowerCase().includes(f));
  }, [lines, filter]);

  const copyVisible = async () => {
    const text = visibleLines.join("\n");
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      throw new Error("clipboard not available");
    } catch {
      window.prompt("复制下面的日志（手动复制）：", text);
    }
  };

  const limitOptions = [
    { value: "100", label: "最近 100 行" },
    { value: "200", label: "最近 200 行" },
    { value: "500", label: "最近 500 行" },
    { value: "1000", label: "最近 1000 行" },
    { value: "2000", label: "最近 2000 行（最多）" },
  ];

  const refreshOptions = [
    { value: "1000", label: "1 秒" },
    { value: "2000", label: "2 秒" },
    { value: "5000", label: "5 秒" },
    { value: "10000", label: "10 秒" },
    { value: "30000", label: "30 秒" },
  ];

  return (
    <div className="space-y-6">
      <div className="glass-panel rounded-2xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="text-sm font-semibold text-gray-900 dark:text-slate-100">mirror-service 运行日志</div>
              <div className="text-xs text-gray-500 dark:text-slate-400">
                {enabled === false ? "未启用（需要配置 MIRROR_LOG_FILE）" : "从日志文件读取最后几行，方便排查卡住/报错原因"}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="ui-btn ui-btn-secondary"
            >
              <RefreshCw className={clsx("w-4 h-4 mr-2", loading && "animate-spin")} />
              刷新
            </button>
            <button type="button" onClick={() => void copyVisible()} className="ui-btn ui-btn-secondary">
              <Copy className="w-4 h-4 mr-2" />
              复制当前显示
            </button>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-1 space-y-4">
            <div className="grid gap-3">
              <label className="text-sm font-medium text-gray-700 dark:text-slate-200">行数</label>
              <Select
                options={limitOptions}
                value={String(limit)}
                onChange={(v) => setLimit(Number.parseInt(v, 10) || 200)}
              />
            </div>

            <div className="grid gap-3">
              <label className="text-sm font-medium text-gray-700 dark:text-slate-200">过滤（包含关键字）</label>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="ui-input"
                placeholder="例如：FLOOD_WAIT / db connection / task paused"
              />
            </div>

            <div className="space-y-3">
              <Checkbox
                label="自动刷新"
                checked={autoRefresh}
                onChange={setAutoRefresh}
                description="开启后会按频率自动刷新日志"
              />
              <div className={clsx(!autoRefresh && "opacity-50 pointer-events-none")}>
                <Select
                  options={refreshOptions}
                  value={String(autoRefreshMs)}
                  onChange={(v) => setAutoRefreshMs(Number.parseInt(v, 10) || 5000)}
                />
              </div>
            </div>

            <div className="text-xs text-gray-500 dark:text-slate-400 space-y-1">
              <div>配置值：{configuredPath || "-"}</div>
              <div>实际路径：{filePath || "-"}</div>
              <div>文件大小：{formatBytes(sizeBytes)}</div>
              <div>更新时间：{formatTime(updatedAt)}</div>
              {truncated ? <div>提示：日志很大，仅截取尾部内容。</div> : null}
            </div>

            {error ? <div className="ui-alert-error">{error}</div> : null}
            {enabled === false ? (
              <div className="ui-alert-info">
                你需要在服务器的 <code>.env</code> 里配置 <code>MIRROR_LOG_FILE</code>（例如 <code>./logs/mirror-service.log</code>），
                然后重启 mirror-service。
              </div>
            ) : null}
          </div>

          <div className="lg:col-span-2">
            <div className="glass-panel rounded-2xl p-4 h-[60vh] overflow-auto">
              {visibleLines.length ? (
                <pre className="text-xs leading-relaxed text-gray-800 dark:text-slate-100 whitespace-pre-wrap">
                  {visibleLines.join("\n")}
                </pre>
              ) : (
                <div className="text-sm text-gray-500 dark:text-slate-400">
                  {enabled === false ? "未启用日志文件。" : "暂无日志（或被过滤条件过滤掉了）。"}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

