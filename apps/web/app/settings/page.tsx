import { SettingsManager } from "@/components/settings/SettingsManager";
import { PageHeader } from "@/components/layout/PageHeader";

export default function SettingsPage() {
  return (
    <div className="p-8 space-y-6">
      <PageHeader title="系统设置" description="配置全局策略（默认镜像方式、媒体组、重试等）。" />

      <SettingsManager />
    </div>
  );
}
