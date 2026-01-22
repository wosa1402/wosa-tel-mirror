import { DashboardSummary } from "@/components/dashboard/DashboardSummary";
import { EventsFeed } from "@/components/events/EventsFeed";
import { TelegramLoginWizard } from "@/components/telegram/TelegramLoginWizard";
import { PageHeader } from "@/components/layout/PageHeader";

export default function Home() {
  return (
    <div className="p-8 space-y-8">
      <PageHeader title="仪表盘" description="欢迎回来！这里是你的 Telegram 频道备份系统概览" />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <DashboardSummary />
        </div>
        <div>
          <TelegramLoginWizard />
        </div>
      </div>

      <EventsFeed />
    </div>
  );
}
