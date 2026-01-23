import { LogsManager } from "@/components/logs/LogsManager";
import { PageHeader } from "@/components/layout/PageHeader";

export default function LogsPage() {
  return (
    <div className="p-8 space-y-6">
      <PageHeader title="运行日志" description="查看 mirror-service 的运行日志（需要配置 MIRROR_LOG_FILE）。" />
      <LogsManager />
    </div>
  );
}

