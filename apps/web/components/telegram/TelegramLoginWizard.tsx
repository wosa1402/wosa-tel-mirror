"use client";

import { useEffect, useState } from "react";
import { getErrorMessage } from "@/lib/utils";

type Step = "phone" | "code" | "password" | "success";

export function TelegramLoginWizard() {
  const [step, setStep] = useState<Step>("phone");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [loginId, setLoginId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);

  const refreshStatus = async () => {
    const res = await fetch("/api/telegram/login/status");
    const data = await res.json();
    setIsLoggedIn(!!data.isLoggedIn);
    if (data.isLoggedIn) setStep("success");
  };

  useEffect(() => {
    refreshStatus().catch(() => {});
  }, []);

  const sendCode = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/telegram/login/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to send code");
      setLoginId(data.loginId);
      setStep("code");
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async (withPassword: boolean) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/telegram/login/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loginId,
          code,
          password: withPassword ? password : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Login failed");

      if (data.requiresPassword) {
        setStep("password");
        return;
      }

      setStep("success");
      await refreshStatus();
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/telegram/logout", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Logout failed");
      setIsLoggedIn(false);
      setStep("phone");
      setCode("");
      setPassword("");
      setLoginId("");
    } catch (e: unknown) {
      setError(getErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="ui-card">
      <div className="space-y-2">
        <h2 className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
          Telegram 登录
        </h2>
        <p className="text-sm text-gray-600 dark:text-slate-300">登录成功后会将 session 加密写入数据库（settings.telegram_session）。</p>
      </div>

      {error ? <div className="ui-alert-error mt-4">{error}</div> : null}

      <div className="mt-6">
        {isLoggedIn ? (
          <div className="space-y-3">
            <div className="text-sm">
              状态：<span className="font-medium text-green-700 dark:text-green-300">已登录</span>
            </div>
            <button type="button" onClick={logout} disabled={loading} className="ui-btn ui-btn-secondary">
              {loading ? "处理中..." : "退出登录"}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {step === "phone" ? (
              <>
                <label className="block text-sm font-medium text-gray-900 dark:text-slate-100">手机号（含国家区号）</label>
                <input
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="+86 13800138000"
                  className="ui-input"
                />
                <button
                  type="button"
                  onClick={sendCode}
                  disabled={loading || !phoneNumber.trim()}
                  className="ui-btn ui-btn-primary w-full"
                >
                  {loading ? "发送中..." : "发送验证码"}
                </button>
              </>
            ) : null}

            {step === "code" ? (
              <>
                <div className="text-sm text-gray-600 dark:text-slate-300">请输入 Telegram 发送到你账号的验证码</div>
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="12345" className="ui-input" />
                <button
                  type="button"
                  onClick={() => verifyCode(false)}
                  disabled={loading || !code.trim() || !loginId}
                  className="ui-btn ui-btn-primary w-full"
                >
                  {loading ? "验证中..." : "验证"}
                </button>
              </>
            ) : null}

            {step === "password" ? (
              <>
                <div className="text-sm text-gray-600 dark:text-slate-300">账号开启了两步验证，请输入 2FA 密码</div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="2FA 密码"
                  className="ui-input"
                />
                <button
                  type="button"
                  onClick={() => verifyCode(true)}
                  disabled={loading || !password || !code.trim() || !loginId}
                  className="ui-btn ui-btn-primary w-full"
                >
                  {loading ? "验证中..." : "确认"}
                </button>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
