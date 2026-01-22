import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";

loadEnv();

function getErrorCauseMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if (!("cause" in error)) return null;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause) return null;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function toIsoStringOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value == null) return null;
  return String(value);
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseMirrorServiceHeartbeat(value: unknown): { lastHeartbeatAt: string | null; startedAt: string | null; pid: number | null } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return {
      lastHeartbeatAt: toIsoStringOrNull(obj.lastHeartbeatAt),
      startedAt: toIsoStringOrNull(obj.startedAt),
      pid: toNumberOrNull(obj.pid),
    };
  }
  return { lastHeartbeatAt: toIsoStringOrNull(value), startedAt: null, pid: null };
}

export async function GET(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const countExpr = sql<number>`count(*)`.mapWith(Number);

    const [channelsRow] = await db
      .select({
        total: countExpr,
        active: sql<number>`count(*) filter (where ${schema.sourceChannels.isActive})`.mapWith(Number),
        protected: sql<number>`count(*) filter (where ${schema.sourceChannels.isProtected})`.mapWith(Number),
      })
      .from(schema.sourceChannels)
      .limit(1);

    const [messagesRow] = await db
      .select({
        total: countExpr,
        pending: sql<number>`count(*) filter (where ${schema.messageMappings.status} = ${"pending"})`.mapWith(Number),
        success: sql<number>`count(*) filter (where ${schema.messageMappings.status} = ${"success"})`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${schema.messageMappings.status} = ${"failed"})`.mapWith(Number),
        skipped: sql<number>`count(*) filter (where ${schema.messageMappings.status} = ${"skipped"})`.mapWith(Number),
      })
      .from(schema.messageMappings)
      .limit(1);

    const [tasksRow] = await db
      .select({
        total: countExpr,
        pending: sql<number>`count(*) filter (where ${schema.syncTasks.status} = ${"pending"})`.mapWith(Number),
        running: sql<number>`count(*) filter (where ${schema.syncTasks.status} = ${"running"})`.mapWith(Number),
        paused: sql<number>`count(*) filter (where ${schema.syncTasks.status} = ${"paused"})`.mapWith(Number),
        completed: sql<number>`count(*) filter (where ${schema.syncTasks.status} = ${"completed"})`.mapWith(Number),
        failed: sql<number>`count(*) filter (where ${schema.syncTasks.status} = ${"failed"})`.mapWith(Number),
      })
      .from(schema.syncTasks)
      .limit(1);

    const runningTaskRows = await db
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
        sourceName: schema.sourceChannels.name,
        sourceChannelIdentifier: schema.sourceChannels.channelIdentifier,
        sourceGroupName: schema.sourceChannels.groupName,
        sourceIsActive: schema.sourceChannels.isActive,
        sourceSyncStatus: schema.sourceChannels.syncStatus,
      })
      .from(schema.syncTasks)
      .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.syncTasks.sourceChannelId))
      .where(eq(schema.syncTasks.status, "running"))
      .orderBy(desc(schema.syncTasks.startedAt), desc(schema.syncTasks.createdAt))
      .limit(10);

    const errorChannelRows = await db
      .select({
        id: schema.sourceChannels.id,
        name: schema.sourceChannels.name,
        channelIdentifier: schema.sourceChannels.channelIdentifier,
        groupName: schema.sourceChannels.groupName,
        syncStatus: schema.sourceChannels.syncStatus,
        isActive: schema.sourceChannels.isActive,
        isProtected: schema.sourceChannels.isProtected,
        lastSyncAt: schema.sourceChannels.lastSyncAt,
        subscribedAt: schema.sourceChannels.subscribedAt,
      })
      .from(schema.sourceChannels)
      .where(eq(schema.sourceChannels.syncStatus, "error"))
      .orderBy(desc(schema.sourceChannels.lastSyncAt), desc(schema.sourceChannels.subscribedAt))
      .limit(10);

    const errorChannelIds = errorChannelRows.map((c) => c.id);
    const latestErrorEventRows = errorChannelIds.length
      ? await db
          .selectDistinctOn([schema.syncEvents.sourceChannelId], {
            id: schema.syncEvents.id,
            sourceChannelId: schema.syncEvents.sourceChannelId,
            level: schema.syncEvents.level,
            message: schema.syncEvents.message,
            createdAt: schema.syncEvents.createdAt,
          })
          .from(schema.syncEvents)
          .where(and(inArray(schema.syncEvents.sourceChannelId, errorChannelIds), eq(schema.syncEvents.level, "error")))
          .orderBy(schema.syncEvents.sourceChannelId, desc(schema.syncEvents.createdAt), desc(schema.syncEvents.id))
      : [];

    const latestErrorEventByChannel = new Map<
      string,
      { id: string; level: (typeof schema.eventLevelEnum.enumValues)[number]; message: string; createdAt: Date }
    >();
    for (const row of latestErrorEventRows) {
      if (!row.sourceChannelId) continue;
      latestErrorEventByChannel.set(row.sourceChannelId, {
        id: row.id,
        level: row.level,
        message: row.message,
        createdAt: row.createdAt,
      });
    }

    const groupChannelRows = await db
      .select({
        groupName: schema.sourceChannels.groupName,
        total: countExpr,
        active: sql<number>`count(*) filter (where ${schema.sourceChannels.isActive})`.mapWith(Number),
        protected: sql<number>`count(*) filter (where ${schema.sourceChannels.isProtected})`.mapWith(Number),
      })
      .from(schema.sourceChannels)
      .groupBy(schema.sourceChannels.groupName)
      .orderBy(schema.sourceChannels.groupName);

    const groupTaskRows = await db
      .select({
        groupName: schema.sourceChannels.groupName,
        status: schema.syncTasks.status,
        count: countExpr,
      })
      .from(schema.syncTasks)
      .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.syncTasks.sourceChannelId))
      .groupBy(schema.sourceChannels.groupName, schema.syncTasks.status);

    const tasksByGroup = new Map<
      string,
      { total: number; pending: number; running: number; paused: number; completed: number; failed: number }
    >();
    for (const row of groupTaskRows) {
      const key = row.groupName ?? "";
      const current = tasksByGroup.get(key) ?? { total: 0, pending: 0, running: 0, paused: 0, completed: 0, failed: 0 };
      current.total += row.count;
      if (row.status === "pending") current.pending += row.count;
      if (row.status === "running") current.running += row.count;
      if (row.status === "paused") current.paused += row.count;
      if (row.status === "completed") current.completed += row.count;
      if (row.status === "failed") current.failed += row.count;
      tasksByGroup.set(key, current);
    }

    const [heartbeatRow] = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, "mirror_service_heartbeat"))
      .limit(1);

    const heartbeat = parseMirrorServiceHeartbeat(heartbeatRow?.value);
    const now = Date.now();
    const lastSeenMs = heartbeat.lastHeartbeatAt ? new Date(heartbeat.lastHeartbeatAt).getTime() : Number.NaN;
    const lagMs = Number.isFinite(lastSeenMs) ? Math.max(0, now - lastSeenMs) : null;
    const online = lagMs != null ? lagMs <= 90_000 : false;

    const response = NextResponse.json({
      channels: {
        total: channelsRow?.total ?? 0,
        active: channelsRow?.active ?? 0,
        protected: channelsRow?.protected ?? 0,
      },
      messages: {
        total: messagesRow?.total ?? 0,
        pending: messagesRow?.pending ?? 0,
        success: messagesRow?.success ?? 0,
        failed: messagesRow?.failed ?? 0,
        skipped: messagesRow?.skipped ?? 0,
      },
      tasks: {
        total: tasksRow?.total ?? 0,
        pending: tasksRow?.pending ?? 0,
        running: tasksRow?.running ?? 0,
        paused: tasksRow?.paused ?? 0,
        completed: tasksRow?.completed ?? 0,
        failed: tasksRow?.failed ?? 0,
      },
      runningTasks: runningTaskRows.map((t) => ({
        id: t.id,
        sourceChannelId: t.sourceChannelId,
        taskType: t.taskType,
        status: t.status,
        progressCurrent: t.progressCurrent,
        progressTotal: t.progressTotal ?? null,
        lastProcessedId: t.lastProcessedId ?? null,
        lastError: t.lastError ?? null,
        createdAt: t.createdAt.toISOString(),
        startedAt: t.startedAt ? t.startedAt.toISOString() : null,
        source: {
          id: t.sourceChannelId,
          name: t.sourceName,
          channelIdentifier: t.sourceChannelIdentifier,
          groupName: t.sourceGroupName ?? "",
          isActive: t.sourceIsActive,
          syncStatus: t.sourceSyncStatus,
        },
      })),
      errorChannels: errorChannelRows.map((c) => {
        const lastErrorEvent = latestErrorEventByChannel.get(c.id) ?? null;
        return {
          id: c.id,
          name: c.name,
          channelIdentifier: c.channelIdentifier,
          groupName: c.groupName ?? "",
          syncStatus: c.syncStatus,
          isActive: c.isActive,
          isProtected: c.isProtected,
          lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
          subscribedAt: c.subscribedAt.toISOString(),
          lastErrorEvent: lastErrorEvent
            ? {
                id: lastErrorEvent.id,
                level: lastErrorEvent.level,
                message: lastErrorEvent.message,
                createdAt: lastErrorEvent.createdAt.toISOString(),
              }
            : null,
        };
      }),
      groups: groupChannelRows.map((g) => ({
        groupName: g.groupName,
        channels: {
          total: g.total,
          active: g.active,
          protected: g.protected,
        },
        tasks: tasksByGroup.get(g.groupName ?? "") ?? { total: 0, pending: 0, running: 0, paused: 0, completed: 0, failed: 0 },
      })),
      mirrorService: {
        online,
        lagSec: lagMs == null ? null : Math.round(lagMs / 1000),
        lastHeartbeatAt: heartbeat.lastHeartbeatAt,
        startedAt: heartbeat.startedAt,
        pid: heartbeat.pid,
      },
    });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    const cause = getErrorCauseMessage(error);
    return NextResponse.json(
      { error: message, cause: process.env.NODE_ENV === "production" ? undefined : cause },
      { status: 500 },
    );
  }
}
