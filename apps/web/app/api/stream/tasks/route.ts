import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db, listenSqlClient, schema, TASKS_NOTIFY_CHANNEL } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { getErrorMessage, getTrimmedString, parseEnumValue, parseIntSafe } from "@/lib/utils";

loadEnv();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function queryTasks(args: {
  sourceChannelId: string;
  hasGroupParam: boolean;
  groupName: string;
  status: (typeof schema.taskStatusEnum.enumValues)[number] | null;
  taskType: (typeof schema.taskTypeEnum.enumValues)[number] | null;
  limit: number;
}) {
  const whereConditions = [
    args.sourceChannelId ? eq(schema.syncTasks.sourceChannelId, args.sourceChannelId) : undefined,
    !args.sourceChannelId && args.hasGroupParam ? eq(schema.sourceChannels.groupName, args.groupName) : undefined,
    args.status ? eq(schema.syncTasks.status, args.status) : undefined,
    args.taskType ? eq(schema.syncTasks.taskType, args.taskType) : undefined,
  ];

  const where = and(...whereConditions);

  const rows = await db
    .select({
      id: schema.syncTasks.id,
      sourceChannelId: schema.syncTasks.sourceChannelId,
      taskType: schema.syncTasks.taskType,
      status: schema.syncTasks.status,
      progressCurrent: schema.syncTasks.progressCurrent,
      progressTotal: schema.syncTasks.progressTotal,
      lastProcessedId: schema.syncTasks.lastProcessedId,
      lastError: schema.syncTasks.lastError,
      createdAt: schema.syncTasks.createdAt,
      startedAt: schema.syncTasks.startedAt,
      completedAt: schema.syncTasks.completedAt,
      pausedAt: schema.syncTasks.pausedAt,
      sourceName: schema.sourceChannels.name,
      sourceChannelIdentifier: schema.sourceChannels.channelIdentifier,
      sourceUsername: schema.sourceChannels.username,
      isActive: schema.sourceChannels.isActive,
    })
    .from(schema.syncTasks)
    .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.syncTasks.sourceChannelId))
    .where(where)
    .orderBy(desc(schema.syncTasks.createdAt))
    .limit(args.limit);

  return rows.map((r) => ({
    id: r.id,
    sourceChannelId: r.sourceChannelId,
    taskType: r.taskType,
    status: r.status,
    progressCurrent: r.progressCurrent,
    progressTotal: r.progressTotal ?? null,
    lastProcessedId: r.lastProcessedId ?? null,
    lastError: r.lastError ?? null,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    pausedAt: r.pausedAt ? r.pausedAt.toISOString() : null,
    source: {
      id: r.sourceChannelId,
      name: r.sourceName,
      channelIdentifier: r.sourceChannelIdentifier,
      username: r.sourceUsername,
      isActive: r.isActive,
    },
  }));
}

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const params = url.searchParams;

  const groupName = getTrimmedString(params.get("groupName") ?? params.get("group_name"));
  const hasGroupParam = params.has("groupName") || params.has("group_name");
  const sourceChannelId = getTrimmedString(params.get("sourceChannelId"));
  const statusRaw = getTrimmedString(params.get("status"));
  const taskTypeRaw = getTrimmedString(params.get("taskType"));
  const limitRaw = getTrimmedString(params.get("limit"));
  const intervalMsRaw = getTrimmedString(params.get("intervalMs") ?? params.get("interval_ms"));

  const limitParsed = limitRaw ? parseIntSafe(limitRaw) : null;
  const limit = clampInt(limitParsed ?? 200, 1, 500);

  const intervalMsParsed = intervalMsRaw ? parseIntSafe(intervalMsRaw) : null;
  const throttleMs = clampInt(intervalMsParsed ?? 1000, 100, 10000);

  const status = statusRaw ? parseEnumValue(schema.taskStatusEnum.enumValues, statusRaw) : null;
  const taskType = taskTypeRaw ? parseEnumValue(schema.taskTypeEnum.enumValues, taskTypeRaw) : null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSnapshot = "";
      let lastSendAt = 0;
      let scheduled = false;
      let notifyPending = false;
      let unlisten: (() => Promise<void>) | null = null;
      let keepAliveTimer: NodeJS.Timeout | null = null;
      let scheduleTimer: NodeJS.Timeout | null = null;

      const safeClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      const sendRaw = (payload: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(payload));
      };

      const sendEvent = (event: string, data: unknown) => {
        sendRaw(`event: ${event}\n`);
        sendRaw(`data: ${JSON.stringify(data)}\n\n`);
      };

      const cleanup = async () => {
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
        if (scheduleTimer) {
          clearTimeout(scheduleTimer);
          scheduleTimer = null;
        }
        if (unlisten) {
          try {
            await unlisten();
          } catch {
            // ignore
          }
          unlisten = null;
        }
        safeClose();
      };

      let resolveAborted: (() => void) | null = null;
      const aborted = new Promise<void>((resolve) => {
        resolveAborted = resolve;
      });
      const triggerAborted = () => {
        if (!resolveAborted) return;
        resolveAborted();
        resolveAborted = null;
      };
      if (request.signal.aborted) triggerAborted();

      const abortHandler = () => {
        triggerAborted();
        void cleanup();
      };
      request.signal.addEventListener("abort", abortHandler);

      const sendTasksNow = async () => {
        if (closed) return;
        try {
          const tasks = await queryTasks({ sourceChannelId, hasGroupParam, groupName, status, taskType, limit });
          const snapshot = JSON.stringify(tasks);
          if (snapshot === lastSnapshot) return;
          lastSnapshot = snapshot;
          lastSendAt = Date.now();
          sendEvent("tasks", { ts: new Date().toISOString(), tasks });
        } catch (error: unknown) {
          sendEvent("server_error", { error: getErrorMessage(error) });
        }
      };

      const scheduleSend = () => {
        if (closed) return;
        notifyPending = true;
        if (scheduled) return;
        scheduled = true;

        const now = Date.now();
        const earliest = Math.max(lastSendAt + throttleMs, now);
        const delay = Math.max(0, earliest - now);

        scheduleTimer = setTimeout(async () => {
          scheduled = false;
          scheduleTimer = null;
          if (!notifyPending) return;
          notifyPending = false;
          await sendTasksNow();
          if (notifyPending) scheduleSend();
        }, delay);
      };

      void (async () => {
        try {
          sendRaw(`retry: 3000\n\n`);

          await sendTasksNow();

          const listenResult = await listenSqlClient.listen(TASKS_NOTIFY_CHANNEL, (payload: string) => {
            if (closed) return;
            if (sourceChannelId) {
              try {
                const parsed = JSON.parse(payload) as { sourceChannelId?: unknown };
                const changedSource = typeof parsed?.sourceChannelId === "string" ? parsed.sourceChannelId : "";
                if (changedSource && changedSource !== sourceChannelId) return;
              } catch {
                // ignore payload parse errors
              }
            }
            scheduleSend();
          });

          unlisten = listenResult.unlisten;

          keepAliveTimer = setInterval(() => {
            if (closed) return;
            sendEvent("ping", { ts: new Date().toISOString() });
          }, 25_000);

          await aborted;
        } catch (error: unknown) {
          sendEvent("server_error", { error: getErrorMessage(error) });
          await cleanup();
        } finally {
          request.signal.removeEventListener("abort", abortHandler);
          await cleanup();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
