import { eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "./utils/env";
import { setupFileLogging } from "./utils/file-logging";
import { sleep } from "./utils/sleep";
import { createFloodWaitAutoResumeScheduler } from "./lib/flood-wait-auto-resume";
import { getChannelHealthCheckSettings } from "./lib/healthcheck";
import { createChannelHealthCheckScheduler } from "./lib/healthcheck-scheduler";
import { MIRROR_SERVICE_HEARTBEAT_INTERVAL_MS, writeMirrorServiceHeartbeat } from "./lib/heartbeat";
import { createRealtimeManager } from "./lib/realtime-manager";
import { createRetryFailedTasksScheduler } from "./lib/retry-failed-scheduler";
import { logSyncEvent } from "./lib/sync-events";
import { createTaskClaimer } from "./lib/task-claimer";
import { processHistoryFullTask } from "./lib/task-history-full";
import { markTaskFailed } from "./lib/task-lifecycle";
import { processResolveTask } from "./lib/task-resolve";
import { processRetryFailedTask } from "./lib/task-retry-failed";
import { notifyTasksChanged } from "./lib/tasks-notify";
import { getTelegramClient } from "./lib/telegram-client";
import { getTaskRunnerSettings } from "./lib/settings";

loadEnv();
const fileLogging = setupFileLogging();
if (fileLogging) {
  console.log(`file logging enabled: ${fileLogging.filePath}`);
}

const FLOOD_WAIT_AUTO_SLEEP_MAX_SEC = (() => {
  const raw = Number.parseInt(process.env.MIRROR_FLOOD_WAIT_MAX_SEC ?? "600", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 600;
  return Math.min(raw, 3600);
})();
const MIRROR_START_RETRY_INTERVAL_SEC = (() => {
  const raw = Number.parseInt(process.env.MIRROR_START_RETRY_INTERVAL_SEC ?? "10", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 10;
  return Math.min(raw, 3600);
})();
const MIRROR_START_RETRY_INTERVAL_MS = MIRROR_START_RETRY_INTERVAL_SEC * 1000;

async function requeueRunningTasks(reason: string): Promise<void> {
  const updated = await db
    .update(schema.syncTasks)
    .set({ status: "pending", startedAt: null, pausedAt: null })
    .where(eq(schema.syncTasks.status, "running"))
    .returning({ id: schema.syncTasks.id, taskType: schema.syncTasks.taskType });

  if (updated.length) {
    console.log(`requeued ${updated.length} running task(s) (${reason})`);
    await logSyncEvent({
      sourceChannelId: null,
      level: "info",
      message: `requeued ${updated.length} running task(s) (${reason})`,
    });
  }
}

async function loop(): Promise<void> {
  const client = await getTelegramClient({
    floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC,
    mirrorStartRetryIntervalSec: MIRROR_START_RETRY_INTERVAL_SEC,
    mirrorStartRetryIntervalMs: MIRROR_START_RETRY_INTERVAL_MS,
  });
  const realtime = createRealtimeManager(client, { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC });
  const healthSettings = getChannelHealthCheckSettings();
  const serviceStartedAt = new Date();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatInFlight = false;

  await logSyncEvent({ sourceChannelId: null, level: "info", message: "mirror-service started" });
  await requeueRunningTasks("startup");

  const runningTasks = new Map<string, Promise<void>>();
  const runningChannelIds = new Set<string>();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        await requeueRunningTasks(signal);
      } catch {
        // ignore
      }
      try {
        await client.disconnect();
      } catch {
        // ignore
      }
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await writeMirrorServiceHeartbeat(serviceStartedAt);
  heartbeatTimer = setInterval(() => {
    if (shuttingDown) return;
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void writeMirrorServiceHeartbeat(serviceStartedAt).finally(() => {
      heartbeatInFlight = false;
    });
  }, MIRROR_SERVICE_HEARTBEAT_INTERVAL_MS);

  let lastRealtimeEnsure = 0;
  let lastConcurrencyLogAt = 0;
  let lastConcurrencyValue = 0;

  const healthScheduler = createChannelHealthCheckScheduler({
    client,
    settings: healthSettings,
    options: { floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC },
    logSyncEvent,
  });

  const retryFailedTasksScheduler = createRetryFailedTasksScheduler();

  const floodWaitAutoResumeScheduler = createFloodWaitAutoResumeScheduler({ notifyTasksChanged, logSyncEvent });

  const startTask = (task: { id: string; taskType: (typeof schema.taskTypeEnum.enumValues)[number]; sourceChannelId: string }) => {
    runningChannelIds.add(task.sourceChannelId);
    const promise = (async () => {
      try {
        if (task.taskType === "resolve") {
          await processResolveTask(client, task.id, task.sourceChannelId, {
            floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC,
          });
          return;
        }
        if (task.taskType === "history_full") {
          await processHistoryFullTask(client, task.id, task.sourceChannelId, {
            floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC,
          });
          return;
        }
        if (task.taskType === "retry_failed") {
          await processRetryFailedTask(client, task.id, task.sourceChannelId, {
            floodWaitAutoSleepMaxSec: FLOOD_WAIT_AUTO_SLEEP_MAX_SEC,
          });
          return;
        }
        await markTaskFailed(task.id, new Error(`unsupported task type: ${task.taskType}`));
      } catch (error: unknown) {
        await markTaskFailed(task.id, error);
      }
    })().finally(() => {
      runningTasks.delete(task.id);
      runningChannelIds.delete(task.sourceChannelId);
    });

    runningTasks.set(task.id, promise);
  };

  const { claimPendingTask } = createTaskClaimer({ runningChannelIds });

  for (;;) {
    try {
      const now = Date.now();
      if (now - lastRealtimeEnsure > 5_000) {
        lastRealtimeEnsure = now;
        await realtime.ensure();
      }

      await retryFailedTasksScheduler.ensure(now);
      await floodWaitAutoResumeScheduler.ensure(now);
      await healthScheduler.ensure(now);

      const { concurrentMirrors } = await getTaskRunnerSettings();
      if (concurrentMirrors !== lastConcurrencyValue && now - lastConcurrencyLogAt > 3_000) {
        lastConcurrencyValue = concurrentMirrors;
        lastConcurrencyLogAt = now;
        console.log(`task runner concurrency: ${concurrentMirrors}`);
      }

      let startedAny = false;

      while (runningTasks.size < concurrentMirrors) {
        const task =
          (await claimPendingTask("resolve")) ??
          (await claimPendingTask("history_full")) ??
          (await claimPendingTask("retry_failed"));

        if (!task) break;
        startTask(task);
        startedAny = true;
      }

      if (!startedAny) {
        await sleep(1_000);
        continue;
      }

      await sleep(200);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`task runner loop error: ${msg}`);
      await sleep(1_000);
    }
  }
}

loop().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  process.exit(1);
});
