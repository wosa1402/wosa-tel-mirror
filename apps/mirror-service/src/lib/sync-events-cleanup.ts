import { sqlClient } from "@tg-back/db";
import { withDbRetry } from "./db-retry";

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;

const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_BATCH_SIZE = 5_000;
const MIN_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 50_000;
const DEFAULT_MAX_BATCHES_PER_RUN = 5;

function parseRetentionDays(): number {
  const raw = process.env.TG_BACK_SYNC_EVENTS_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
  if (parsed <= 0) return 0; // 0 = 禁用清理
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, parsed));
}

function parseBatchSize(): number {
  const raw = process.env.TG_BACK_SYNC_EVENTS_CLEANUP_BATCH_SIZE?.trim();
  if (!raw) return DEFAULT_BATCH_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, parsed));
}

function parseMaxBatchesPerRun(): number {
  const raw = process.env.TG_BACK_SYNC_EVENTS_CLEANUP_MAX_BATCHES?.trim();
  if (!raw) return DEFAULT_MAX_BATCHES_PER_RUN;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BATCHES_PER_RUN;
  return Math.min(50, Math.max(1, parsed));
}

async function deleteOneBatch(cutoff: Date, batchSize: number): Promise<number> {
  const rows = (await withDbRetry(
    () => sqlClient`
      with deleted as (
        delete from sync_events
        where id in (
          select id from sync_events
          where created_at < ${cutoff}
          order by created_at asc
          limit ${batchSize}
        )
        returning 1
      )
      select count(*)::int as count from deleted
    `,
    "cleanup sync_events",
    { attempts: 3, baseDelayMs: 250 },
  )) as Array<{ count: unknown }>;

  const countValue = rows?.[0]?.count;
  const deleted = typeof countValue === "number" ? countValue : Number.parseInt(String(countValue ?? "0"), 10);
  return Number.isFinite(deleted) ? deleted : 0;
}

type SyncEventsCleanupSchedulerDeps = {
  checkIntervalMs?: number;
  logSyncEvent: (args: { sourceChannelId: string | null; level: "info" | "warn" | "error"; message: string }) => Promise<void>;
};

export function createSyncEventsCleanupScheduler({
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  logSyncEvent,
}: SyncEventsCleanupSchedulerDeps): {
  ensure: (now: number) => Promise<void>;
} {
  const retentionDays = parseRetentionDays();
  const batchSize = parseBatchSize();
  const maxBatchesPerRun = parseMaxBatchesPerRun();

  let lastEnsureAt = 0;

  const ensure = async (now: number): Promise<void> => {
    if (now - lastEnsureAt < checkIntervalMs) return;
    lastEnsureAt = now;
    if (retentionDays <= 0) return;

    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000);

    let totalDeleted = 0;
    for (let i = 0; i < maxBatchesPerRun; i += 1) {
      const deleted = await deleteOneBatch(cutoff, batchSize);
      totalDeleted += deleted;
      if (deleted < batchSize) break;
    }

    if (totalDeleted <= 0) return;

    const message = `sync_events cleanup: deleted ${totalDeleted} row(s) older than ${retentionDays} day(s)`;
    console.log(message);
    await logSyncEvent({ sourceChannelId: null, level: "info", message });
  };

  return { ensure };
}
