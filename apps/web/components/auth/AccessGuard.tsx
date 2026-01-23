"use client";

import { useEffect, useMemo, useState } from "react";

type Status = { enabled: boolean; authed: boolean };

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function AccessGuard({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = async (): Promise<Status> => {
    const res = await fetch("/api/auth/status", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Failed to check access status");
    const next = { enabled: !!data.enabled, authed: !!data.authed };
    setStatus(next);
    return next;
  };

  useEffect(() => {
    refresh().catch((e: unknown) => setError(getErrorMessage(e)));
  }, []);

  const canSubmit = useMemo(() => password.trim().length > 0 && !loading, [password, loading]);

  const login = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Login failed");
      setPassword("");
      await refresh();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  if (!status) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="glass-panel w-full max-w-md rounded-2xl p-8">
          <div className="text-sm text-gray-600 dark:text-slate-300">加载中...</div>
        </div>
      </div>
    );
  }

  if (!status.enabled || status.authed) return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="glass-panel w-full max-w-md rounded-2xl p-8">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            需要访问密码
          </h1>
          <p className="text-sm text-gray-600 dark:text-slate-300">该 Web 已启用访问控制，请输入密码继续。</p>
        </div>

        {error ? <div className="ui-alert-error mt-4">{error}</div> : null}

        <div className="mt-6 space-y-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="访问密码"
            className="ui-input"
          />
          <button type="button" onClick={login} disabled={!canSubmit} className="ui-btn ui-btn-primary w-full">
            {loading ? "验证中..." : "进入"}
          </button>
        </div>
        </div>
    </div>
  );
}
