import { ChannelsManager } from "@/components/channels/ChannelsManager";
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

function toEnumOrDefault<T extends readonly string[]>(allowed: T, value: string, fallback: T[number]): T[number] {
  const v = value.trim();
  return (allowed as readonly string[]).includes(v) ? (v as T[number]) : fallback;
}

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const groupKey = hasOwn(sp, "groupName") ? "groupName" : hasOwn(sp, "group_name") ? "group_name" : null;
  const groupRaw = groupKey ? getString(sp[groupKey]) : "";
  const groupTrimmed = groupRaw.trim();
  const initialGroupName = groupKey ? (groupTrimmed ? groupTrimmed : UNGROUPED) : "";
  const initialQuery = getString(sp.q).trim();
  const initialActive = toEnumOrDefault(["all", "active", "inactive"] as const, getString(sp.active), "all");
  const initialProtected = toEnumOrDefault(["all", "protected", "unprotected"] as const, getString(sp.protected), "all");
  const initialResolved = toEnumOrDefault(["all", "resolved", "unresolved"] as const, getString(sp.resolved), "all");
  const initialSyncStatus = toEnumOrDefault(
    ["all", "pending", "syncing", "completed", "error"] as const,
    getString(sp.syncStatus),
    "all",
  );
  const initialSortBy = toEnumOrDefault(
    ["default", "priority_desc", "name_asc", "last_sync_desc"] as const,
    getString(sp.sortBy),
    "default",
  );

  return (
    <div className="p-8 space-y-6">
      <PageHeader
        title="频道管理"
        description="添加源频道后，mirror-service 会自动 resolve → history_full（历史）→ realtime（实时）。"
      />

      <ChannelsManager
        initialGroupName={initialGroupName}
        initialQuery={initialQuery}
        initialActiveFilter={initialActive}
        initialProtectedFilter={initialProtected}
        initialResolvedFilter={initialResolved}
        initialSyncStatusFilter={initialSyncStatus}
        initialSortBy={initialSortBy}
      />
    </div>
  );
}
