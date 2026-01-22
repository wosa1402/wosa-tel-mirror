import { EventsManager } from "@/components/events/EventsManager";
import { PageHeader } from "@/components/layout/PageHeader";

const UNGROUPED = "__ungrouped__";

function getString(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? "";
  return "";
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function toEventLevelOrEmpty(value: string): string {
  const v = value.trim();
  if (v === "info" || v === "warn" || v === "error") return v;
  return "";
}

function toLimitOrDefault(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 50;
  return Math.min(200, Math.max(1, Math.trunc(n)));
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const groupKey = hasOwn(sp, "groupName") ? "groupName" : hasOwn(sp, "group_name") ? "group_name" : null;
  const groupRaw = groupKey ? getString(sp[groupKey]) : "";
  const groupTrimmed = groupRaw.trim();
  const initialGroupName = groupKey ? (groupTrimmed ? groupTrimmed : UNGROUPED) : "";
  const initialSourceChannelId = getString(sp.sourceChannelId).trim();
  const initialLevel = toEventLevelOrEmpty(getString(sp.level));
  const initialQuery = getString(sp.q).trim();
  const initialLimit = toLimitOrDefault(getString(sp.limit));

  return (
    <div className="p-8 space-y-6">
      <PageHeader title="事件中心" description="查看 sync_events（关键事件日志），支持筛选与搜索。" />

      <EventsManager
        initialGroupName={initialGroupName}
        initialSourceChannelId={initialSourceChannelId}
        initialLevel={initialLevel}
        initialQuery={initialQuery}
        initialLimit={initialLimit}
      />
    </div>
  );
}
