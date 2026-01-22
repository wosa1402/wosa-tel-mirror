import { MessagesBrowser } from "@/components/messages/MessagesBrowser";
import { PageHeader } from "@/components/layout/PageHeader";

export default function MessagesPage() {
  return (
    <div className="p-8 space-y-6">
      <PageHeader
        title="消息浏览"
        description="从数据库读取 message_mappings（元数据/文本），支持筛选、跳转与导出。"
      />

      <MessagesBrowser />
    </div>
  );
}
