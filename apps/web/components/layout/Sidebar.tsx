"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Activity, FileText, Home, ListTodo, MessageSquare, Radio, Send, Settings } from "lucide-react";
import { formatTime } from "@/lib/utils";

type NavItem = { name: string; href: string };

type MirrorServiceStatus = {
  online: boolean;
  lagSec: number | null;
  lastHeartbeatAt: string | null;
};

const navigation: Array<NavItem & { icon: React.ComponentType<{ className?: string }> }> = [
  { name: "仪表盘", href: "/", icon: Home },
  { name: "频道管理", href: "/channels", icon: Radio },
  { name: "消息浏览", href: "/messages", icon: MessageSquare },
  { name: "任务管理", href: "/tasks", icon: ListTodo },
  { name: "事件中心", href: "/events", icon: Activity },
  { name: "运行日志", href: "/logs", icon: FileText },
  { name: "系统设置", href: "/settings", icon: Settings },
];

function formatLag(lagSec: number | null | undefined): string {
  if (typeof lagSec !== "number" || !Number.isFinite(lagSec)) return "";
  if (lagSec <= 0) return "lag 0s";
  if (lagSec < 60) return `lag ${Math.round(lagSec)}s`;
  const mins = Math.round(lagSec / 60);
  return `lag ${mins}m`;
}

function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();
  const [status, setStatus] = useState<MirrorServiceStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const res = await fetch("/api/dashboard", { cache: "no-store" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) return;
        const next = json.mirrorService as MirrorServiceStatus | undefined;
        if (!next) return;
        if (!cancelled) setStatus(next);
      } catch {
        // ignore
      }
    };

    void refresh();
    const id = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const statusText = useMemo(() => {
    if (!status) return { title: "同步服务", sub: "状态未知", dot: "bg-gray-300 dark:bg-slate-600" };
    if (!status.online) return { title: "同步服务", sub: "离线", dot: "bg-red-500" };
    const lag = formatLag(status.lagSec);
    const hb = status.lastHeartbeatAt ? `last ${formatTime(status.lastHeartbeatAt)}` : "";
    const sub = [lag, hb].filter(Boolean).join(" · ") || "在线";
    return { title: "同步服务", sub, dot: "bg-green-500 animate-pulse" };
  }, [status]);

  return (
    <aside className="w-72 shrink-0 glass-panel border-r border-white/20 dark:border-white/10 flex flex-col sticky top-0 h-screen">
      <div className="p-8">
        <Link href="/" className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center">
            <Send className="w-6 h-6 text-white" />
          </div>
          <div>
            <div className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
              tg-back
            </div>
            <div className="text-xs text-gray-500 dark:text-slate-400">Telegram 频道备份</div>
          </div>
        </Link>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-4 space-y-1">
        {navigation.map((item) => {
          const active = isActivePath(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200",
                active
                  ? "bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg shadow-blue-500/30"
                  : "text-gray-700 hover:bg-white/60 dark:text-slate-200 dark:hover:bg-slate-800/60",
              )}
            >
              <Icon className="w-5 h-5" />
              <span className="font-medium">{item.name}</span>
            </Link>
          );
        })}
      </nav>

      <div className="p-6 border-t border-white/20 dark:border-white/10">
        <div className="glass-panel rounded-xl p-4">
          <div className="flex items-center gap-3">
            <div className={clsx("w-3 h-3 rounded-full", statusText.dot)} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-slate-100">{statusText.title}</p>
              <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{statusText.sub}</p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
