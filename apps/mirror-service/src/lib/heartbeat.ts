import { db, schema } from "@tg-back/db";
import { withDbRetry } from "./db-retry";

const MIRROR_SERVICE_HEARTBEAT_KEY = "mirror_service_heartbeat";
export const MIRROR_SERVICE_HEARTBEAT_INTERVAL_MS = 30_000;

export async function writeMirrorServiceHeartbeat(startedAt: Date): Promise<void> {
  const value = {
    lastHeartbeatAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    pid: process.pid,
  };

  try {
    await withDbRetry(
      () =>
        db
          .insert(schema.settings)
          .values({ key: MIRROR_SERVICE_HEARTBEAT_KEY, value })
          .onConflictDoUpdate({ target: schema.settings.key, set: { value } }),
      "mirror-service heartbeat",
      { attempts: 1, baseDelayMs: 250 },
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`failed to write mirror-service heartbeat: ${msg}`);
  }
}

