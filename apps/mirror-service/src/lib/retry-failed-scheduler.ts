import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { withDbRetry } from "./db-retry";
import { getRetryBehaviorSettings } from "./settings";

type RetryFailedTasksSchedulerDeps = {
  checkIntervalMs?: number;
};

export function createRetryFailedTasksScheduler({ checkIntervalMs = 10_000 }: RetryFailedTasksSchedulerDeps = {}): {
  ensure: (now: number) => Promise<void>;
} {
  let lastEnsureAt = 0;

  const ensure = async (now: number): Promise<void> => {
    if (now - lastEnsureAt < checkIntervalMs) return;
    lastEnsureAt = now;
    await ensureRetryFailedTasks(now);
  };

  return { ensure };
}

async function ensureRetryFailedTasks(now: number): Promise<void> {
  const { maxRetryCount, retryIntervalSec } = await getRetryBehaviorSettings();
  if (maxRetryCount <= 0) return;

  const threshold = retryIntervalSec > 0 ? new Date(now - retryIntervalSec * 1000) : null;

  const whereConditions: any[] = [
    eq(schema.messageMappings.status, "failed"),
    lt(schema.messageMappings.retryCount, maxRetryCount),
    or(isNull(schema.messageMappings.skipReason), ne(schema.messageMappings.skipReason, "protected_content")),
    eq(schema.sourceChannels.isActive, true),
    sql`${schema.sourceChannels.telegramId} is not null`,
    sql`${schema.mirrorChannels.telegramId} is not null`,
  ];

  if (threshold) {
    whereConditions.push(or(isNull(schema.messageMappings.mirroredAt), lt(schema.messageMappings.mirroredAt, threshold)));
  }

  const candidates = await withDbRetry(
    () =>
      db
        .select({ sourceChannelId: schema.messageMappings.sourceChannelId })
        .from(schema.messageMappings)
        .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.messageMappings.sourceChannelId))
        .innerJoin(schema.mirrorChannels, eq(schema.mirrorChannels.sourceChannelId, schema.messageMappings.sourceChannelId))
        .where(and(...whereConditions))
        .groupBy(schema.messageMappings.sourceChannelId)
        .limit(20),
    "ensure retry_failed candidates",
    { attempts: 3, baseDelayMs: 250 },
  );

  if (!candidates.length) return;

  const sourceChannelIds = candidates.map((c) => c.sourceChannelId);

  const existing = await withDbRetry(
    () =>
      db
        .select({
          id: schema.syncTasks.id,
          sourceChannelId: schema.syncTasks.sourceChannelId,
          status: schema.syncTasks.status,
          lastError: schema.syncTasks.lastError,
          createdAt: schema.syncTasks.createdAt,
        })
        .from(schema.syncTasks)
        .where(and(inArray(schema.syncTasks.sourceChannelId, sourceChannelIds), eq(schema.syncTasks.taskType, "retry_failed")))
        .orderBy(desc(schema.syncTasks.createdAt)),
    "ensure retry_failed tasks",
    { attempts: 3, baseDelayMs: 250 },
  );

  const taskByChannel = new Map<string, (typeof existing)[number]>();
  for (const row of existing) {
    if (!taskByChannel.has(row.sourceChannelId)) taskByChannel.set(row.sourceChannelId, row);
  }

  const inserts: Array<typeof schema.syncTasks.$inferInsert> = [];

  for (const channelId of sourceChannelIds) {
    const task = taskByChannel.get(channelId) ?? null;
    if (!task) {
      inserts.push({ sourceChannelId: channelId, taskType: "retry_failed", status: "pending" });
      continue;
    }

    if (task.status === "pending" || task.status === "running") continue;
    if (task.status === "paused") continue;

    await withDbRetry(
      () =>
        db
          .update(schema.syncTasks)
          .set({
            status: "pending",
            startedAt: null,
            pausedAt: null,
            completedAt: null,
            lastError: null,
            progressCurrent: 0,
            progressTotal: null,
            lastProcessedId: null,
          })
          .where(eq(schema.syncTasks.id, task.id)),
      `requeue retry_failed (taskId=${task.id})`,
      { attempts: 3, baseDelayMs: 250 },
    );
  }

  if (inserts.length) {
    await withDbRetry(
      () => db.insert(schema.syncTasks).values(inserts).onConflictDoNothing(),
      `create retry_failed tasks (n=${inserts.length})`,
      {
        attempts: 3,
        baseDelayMs: 250,
      },
    );
  }
}
