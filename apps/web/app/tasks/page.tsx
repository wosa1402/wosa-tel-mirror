import { TasksManager } from "@/components/tasks/TasksManager";
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

function toTaskStatusOrEmpty(value: string): string {
  const v = value.trim();
  if (v === "pending" || v === "running" || v === "paused" || v === "completed" || v === "failed") return v;
  return "";
}

function toTaskTypeOrEmpty(value: string): string {
  const v = value.trim();
  if (v === "resolve" || v === "history_full" || v === "history_partial" || v === "realtime" || v === "retry_failed") return v;
  return "";
}

function toLimitOrDefault(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 200;
  return Math.min(500, Math.max(1, Math.trunc(n)));
}

function toViewModeOrDefault(value: string): "channel" | "task" {
  const v = value.trim();
  if (v === "task") return "task";
  return "channel";
}

function toBoolOrDefault(value: string, defaultValue: boolean): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return defaultValue;
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return defaultValue;
}

export default async function TasksPage({
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
  const initialStatus = toTaskStatusOrEmpty(getString(sp.status));
  const initialTaskType = toTaskTypeOrEmpty(getString(sp.taskType));
  const initialLimit = toLimitOrDefault(getString(sp.limit));
  const initialViewMode = toViewModeOrDefault(getString(sp.viewMode));
  const initialHideCompleted = toBoolOrDefault(getString(sp.hideCompleted), true);

  return (
    <div className="p-8 space-y-6">
      <PageHeader title="任务管理" description="查看与控制 sync_tasks（resolve/history_full/realtime/retry_failed）。" />

      <TasksManager
        initialGroupName={initialGroupName}
        initialSourceChannelId={initialSourceChannelId}
        initialStatus={initialStatus}
        initialTaskType={initialTaskType}
        initialLimit={initialLimit}
        initialViewMode={initialViewMode}
        initialHideCompleted={initialHideCompleted}
      />
    </div>
  );
}
