import { and, asc, desc, eq, ne, notInArray, sql } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { withDbRetry } from "./db-retry";
import { notifyTasksChanged } from "./tasks-notify";

type TaskType = (typeof schema.taskTypeEnum.enumValues)[number];

export function createTaskClaimer(deps: { runningChannelIds: Set<string> }): {
  claimPendingTask: (taskType: TaskType) => Promise<{ id: string; taskType: TaskType; sourceChannelId: string } | null>;
} {
  const claimPendingTask = async (
    taskType: TaskType,
  ): Promise<{ id: string; taskType: TaskType; sourceChannelId: string } | null> => {
    const excludedChannelIds = deps.runningChannelIds.size ? [...deps.runningChannelIds] : null;
    const excludedCondition = excludedChannelIds ? notInArray(schema.syncTasks.sourceChannelId, excludedChannelIds) : undefined;

    const row =
      taskType === "resolve"
        ? (
            await withDbRetry(
              () =>
                db
                  .select({ id: schema.syncTasks.id, sourceChannelId: schema.syncTasks.sourceChannelId })
                  .from(schema.syncTasks)
                  .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.syncTasks.sourceChannelId))
                  .where(
                    and(
                      eq(schema.syncTasks.status, "pending"),
                      eq(schema.syncTasks.taskType, taskType),
                      eq(schema.sourceChannels.isActive, true),
                      ne(schema.sourceChannels.syncStatus, "error"),
                      excludedCondition,
                    ),
                  )
                  .orderBy(desc(schema.sourceChannels.priority), asc(schema.syncTasks.createdAt))
                  .limit(1),
              `claim pending task (${taskType})`,
              { attempts: 3, baseDelayMs: 250 },
            )
          )[0]
        : (
            await withDbRetry(
              () =>
                db
                  .select({ id: schema.syncTasks.id, sourceChannelId: schema.syncTasks.sourceChannelId })
                  .from(schema.syncTasks)
                  .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.syncTasks.sourceChannelId))
                  .innerJoin(schema.mirrorChannels, eq(schema.mirrorChannels.sourceChannelId, schema.syncTasks.sourceChannelId))
                  .where(
                    and(
                      eq(schema.syncTasks.status, "pending"),
                      eq(schema.syncTasks.taskType, taskType),
                      eq(schema.sourceChannels.isActive, true),
                      ne(schema.sourceChannels.syncStatus, "error"),
                      excludedCondition,
                      sql`${schema.sourceChannels.telegramId} is not null`,
                      sql`${schema.mirrorChannels.telegramId} is not null`,
                    ),
                  )
                  .orderBy(desc(schema.sourceChannels.priority), asc(schema.syncTasks.createdAt))
                  .limit(1),
              `claim pending task (${taskType})`,
              { attempts: 3, baseDelayMs: 250 },
            )
          )[0];

    if (!row) return null;

    const claimed = await withDbRetry(
      () =>
        db
          .update(schema.syncTasks)
          .set({ status: "running", startedAt: new Date() })
          .where(and(eq(schema.syncTasks.id, row.id), eq(schema.syncTasks.status, "pending")))
          .returning({ id: schema.syncTasks.id }),
      `claim task row (taskType=${taskType}, taskId=${row.id})`,
      { attempts: 3, baseDelayMs: 250 },
    );

    if (!claimed.length) return null;
    void notifyTasksChanged({ taskId: row.id, sourceChannelId: row.sourceChannelId, taskType, status: "running" });
    return { id: row.id, taskType, sourceChannelId: row.sourceChannelId };
  };

  return { claimPendingTask };
}

