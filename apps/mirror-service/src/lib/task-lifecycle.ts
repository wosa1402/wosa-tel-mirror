import { eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { getDbErrorMeta, withDbRetry } from "./db-retry";
import { logSyncEvent } from "./sync-events";
import { notifyTasksChanged } from "./tasks-notify";
import { getTelegramErrorMessage } from "./telegram-errors";

export async function markTaskFailed(taskId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : getTelegramErrorMessage(error) ?? String(error);
  console.error(`task failed: ${taskId} - ${message}`);

  let updated: Array<{
    sourceChannelId: string;
    taskType: (typeof schema.taskTypeEnum.enumValues)[number];
  }> = [];

  try {
    updated = await withDbRetry(
      () =>
        db
          .update(schema.syncTasks)
          .set({ status: "failed", lastError: message, completedAt: new Date() })
          .where(eq(schema.syncTasks.id, taskId))
          .returning({ sourceChannelId: schema.syncTasks.sourceChannelId, taskType: schema.syncTasks.taskType }),
      `mark task failed (taskId=${taskId})`,
      { attempts: 3, baseDelayMs: 250 },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`failed to mark task failed: ${taskId}${getDbErrorMeta(e)} - ${msg}`);
  }

  const sourceChannelId = updated[0]?.sourceChannelId ?? null;
  const taskType = updated[0]?.taskType ?? null;

  void notifyTasksChanged({
    taskId,
    sourceChannelId: sourceChannelId ?? undefined,
    taskType: taskType ?? undefined,
    status: "failed",
  });

  if (sourceChannelId && (taskType === "resolve" || taskType === "history_full")) {
    try {
      await withDbRetry(
        () =>
          db
            .update(schema.sourceChannels)
            .set({ syncStatus: "error" })
            .where(eq(schema.sourceChannels.id, sourceChannelId)),
        `mark source channel error (taskId=${taskId}, taskType=${taskType})`,
        { attempts: 3, baseDelayMs: 250 },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`failed to mark source channel error: ${sourceChannelId}${getDbErrorMeta(e)} - ${msg}`);
    }
  }

  try {
    await logSyncEvent({
      sourceChannelId,
      level: "error",
      message: `task failed: ${taskType ?? "unknown"} (taskId=${taskId}) - ${message}`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`failed to log sync event: ${msg}`);
  }
}

export async function pauseTask(
  taskId: string,
  reason: string,
  options?: {
    progressCurrent?: number;
    progressTotal?: number | null;
    lastProcessedId?: number | null;
  },
): Promise<void> {
  const set: Partial<typeof schema.syncTasks.$inferInsert> = {
    status: "paused",
    pausedAt: new Date(),
    lastError: reason,
  };

  if (typeof options?.progressCurrent === "number" && Number.isFinite(options.progressCurrent)) {
    set.progressCurrent = options.progressCurrent;
  }
  if (options?.progressTotal !== undefined) {
    set.progressTotal = options.progressTotal;
  }
  if (options?.lastProcessedId !== undefined) {
    set.lastProcessedId = options.lastProcessedId;
  }

  const updated = await withDbRetry(
    () =>
      db
        .update(schema.syncTasks)
        .set(set)
        .where(eq(schema.syncTasks.id, taskId))
        .returning({
          sourceChannelId: schema.syncTasks.sourceChannelId,
          taskType: schema.syncTasks.taskType,
          progressCurrent: schema.syncTasks.progressCurrent,
          progressTotal: schema.syncTasks.progressTotal,
          lastProcessedId: schema.syncTasks.lastProcessedId,
        }),
    `pause task (taskId=${taskId})`,
    { attempts: 3, baseDelayMs: 250 },
  );

  const row = updated[0] ?? null;
  const progressCurrent = row?.progressCurrent;
  const progressTotal = row?.progressTotal ?? null;
  const lastProcessedId = row?.lastProcessedId ?? null;

  console.log(`task paused: ${taskId} - ${reason}`);

  void notifyTasksChanged({
    taskId,
    sourceChannelId: row?.sourceChannelId ?? undefined,
    taskType: row?.taskType ?? undefined,
    status: "paused",
  });

  const hasProgressInfo =
    (typeof progressCurrent === "number" && progressCurrent > 0) ||
    (typeof progressTotal === "number" && Number.isFinite(progressTotal)) ||
    (typeof lastProcessedId === "number" && Number.isFinite(lastProcessedId) && lastProcessedId > 0);

  const progressDetails = hasProgressInfo
    ? ` (progress=${progressCurrent ?? "-"}${progressTotal == null ? "" : `/${progressTotal}`} lastId=${lastProcessedId ?? "-"})`
    : "";

  await logSyncEvent({
    sourceChannelId: row?.sourceChannelId ?? null,
    level: "warn",
    message: `task paused: ${row?.taskType ?? "unknown"} (taskId=${taskId}) - ${reason}${progressDetails}`,
  });
}

