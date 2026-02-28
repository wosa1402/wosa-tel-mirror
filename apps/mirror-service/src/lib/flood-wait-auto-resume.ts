import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { withDbRetry } from "./db-retry";
import { parseFloodWaitSeconds } from "./telegram-errors";

type SyncEventLevel = (typeof schema.eventLevelEnum.enumValues)[number];

type FloodWaitAutoResumeSchedulerDeps = {
  checkIntervalMs?: number;
  notifyTasksChanged: (payload: {
    taskId?: string;
    sourceChannelId?: string;
    taskType?: string;
    status?: string;
  }) => void | Promise<void>;
  logSyncEvent: (args: { sourceChannelId: string | null; level: SyncEventLevel; message: string }) => Promise<void>;
};

export function createFloodWaitAutoResumeScheduler({
  checkIntervalMs = 5_000,
  notifyTasksChanged,
  logSyncEvent,
}: FloodWaitAutoResumeSchedulerDeps): {
  ensure: (now: number) => Promise<void>;
} {
  let lastEnsureAt = 0;

  const ensure = async (now: number): Promise<void> => {
    if (now - lastEnsureAt < checkIntervalMs) return;
    lastEnsureAt = now;

    const rows = await withDbRetry(
      () =>
        db
          .select({
            id: schema.syncTasks.id,
            sourceChannelId: schema.syncTasks.sourceChannelId,
            taskType: schema.syncTasks.taskType,
            pausedAt: schema.syncTasks.pausedAt,
            lastError: schema.syncTasks.lastError,
          })
          .from(schema.syncTasks)
          .where(
            and(
              eq(schema.syncTasks.status, "paused"),
              sql`${schema.syncTasks.pausedAt} is not null`,
              sql`${schema.syncTasks.lastError} is not null`,
            ),
          )
          .orderBy(asc(schema.syncTasks.pausedAt))
          .limit(50),
      "auto resume flood wait tasks",
      { attempts: 3, baseDelayMs: 250 },
    );

    for (const row of rows) {
      if (!row.pausedAt) continue;
      const waitSeconds = parseFloodWaitSeconds(row.lastError ?? "");
      if (!waitSeconds || !Number.isFinite(waitSeconds) || waitSeconds <= 0) continue;

      const resumeAtMs = row.pausedAt.getTime() + (waitSeconds + 1) * 1000;
      if (now < resumeAtMs) continue;

      await withDbRetry(
        () =>
          db
            .update(schema.syncTasks)
            .set({ status: "pending", startedAt: null, pausedAt: null, lastError: null })
            .where(eq(schema.syncTasks.id, row.id)),
        `auto resume flood wait (taskId=${row.id})`,
        { attempts: 3, baseDelayMs: 250 },
      );

      void notifyTasksChanged({ taskId: row.id, sourceChannelId: row.sourceChannelId, taskType: row.taskType, status: "pending" });

      await logSyncEvent({
        sourceChannelId: row.sourceChannelId,
        level: "info",
        message: `auto resumed task after FLOOD_WAIT_${waitSeconds}s (taskId=${row.id}, taskType=${row.taskType})`,
      });
    }
  };

  return { ensure };
}

