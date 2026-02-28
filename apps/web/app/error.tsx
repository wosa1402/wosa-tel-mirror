"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const detail =
    process.env.NODE_ENV === "development" ? error.message : "发生了未知错误，你可以点击“重试”，或刷新页面再试一次。";

  return (
    <div className="p-8">
      <div className="ui-card space-y-4 max-w-xl">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">页面出错了</h2>
          <p className="text-sm text-gray-600 dark:text-slate-300">{detail}</p>
        </div>

        <div className="flex flex-wrap gap-3">
          <button type="button" className="ui-btn ui-btn-primary" onClick={reset}>
            重试
          </button>
          <button type="button" className="ui-btn ui-btn-secondary" onClick={() => window.location.reload()}>
            刷新页面
          </button>
        </div>
      </div>
    </div>
  );
}

