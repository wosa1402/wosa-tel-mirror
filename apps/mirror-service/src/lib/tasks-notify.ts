import { sqlClient, TASKS_NOTIFY_CHANNEL } from "@tg-back/db";

let lastNotifyErrorAt = 0;

export async function notifyTasksChanged(payload: {
  taskId?: string;
  sourceChannelId?: string;
  taskType?: string;
  status?: string;
}): Promise<void> {
  try {
    await sqlClient.notify(
      TASKS_NOTIFY_CHANNEL,
      JSON.stringify({
        ts: new Date().toISOString(),
        ...payload,
      }),
    );
  } catch (error: unknown) {
    const now = Date.now();
    if (now - lastNotifyErrorAt < 10_000) return;
    lastNotifyErrorAt = now;
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to notify tasks change: ${msg}`);
  }
}

