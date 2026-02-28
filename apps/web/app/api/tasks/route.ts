import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db, schema, sqlClient, TASKS_NOTIFY_CHANNEL } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { toPublicErrorMessage } from "@/lib/api-error";
import { getTrimmedString, parseEnumValue, parseIntSafe } from "@/lib/utils";

loadEnv();

export async function GET(request: NextRequest) {
  try {
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

    const limitParsed = limitRaw ? parseIntSafe(limitRaw) : null;
    const limit = Math.min(Math.max(limitParsed ?? 200, 1), 500);

    const status = statusRaw ? parseEnumValue(schema.taskStatusEnum.enumValues, statusRaw) : null;
    const taskType = taskTypeRaw ? parseEnumValue(schema.taskTypeEnum.enumValues, taskTypeRaw) : null;

    const whereConditions = [
      sourceChannelId ? eq(schema.syncTasks.sourceChannelId, sourceChannelId) : undefined,
      !sourceChannelId && hasGroupParam ? eq(schema.sourceChannels.groupName, groupName) : undefined,
      status ? eq(schema.syncTasks.status, status) : undefined,
      taskType ? eq(schema.syncTasks.taskType, taskType) : undefined,
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
      .limit(limit);

    return NextResponse.json({
      tasks: rows.map((r) => ({
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
      })),
    });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: toPublicErrorMessage(error, "加载任务失败") }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const action = typeof body.action === "string" ? body.action.trim() : "";

    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    if (action !== "requeue" && action !== "restart" && action !== "pause" && action !== "resume") {
      return NextResponse.json({ error: "action must be requeue|restart|pause|resume" }, { status: 400 });
    }

    const [task] = await db
      .select({
        id: schema.syncTasks.id,
        status: schema.syncTasks.status,
        taskType: schema.syncTasks.taskType,
        sourceChannelId: schema.syncTasks.sourceChannelId,
      })
      .from(schema.syncTasks)
      .where(eq(schema.syncTasks.id, id))
      .limit(1);

    if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });
    if ((action === "requeue" || action === "restart") && task.status === "running") {
      return NextResponse.json({ error: "task is running" }, { status: 409 });
    }

    const set: Partial<typeof schema.syncTasks.$inferInsert> = {};

    if (action === "pause") {
      if (task.status === "completed") return NextResponse.json({ error: "task is completed" }, { status: 409 });
      if (task.status === "failed") return NextResponse.json({ error: "task is failed" }, { status: 409 });
      if (task.status !== "paused") {
        set.status = "paused";
        set.pausedAt = new Date();
        set.lastError = "paused manually";
      }
    } else if (action === "resume") {
      if (task.status !== "paused") return NextResponse.json({ error: "task is not paused" }, { status: 409 });
      set.status = "pending";
      set.startedAt = null;
      set.pausedAt = null;
      set.completedAt = null;
      set.lastError = null;
    } else {
      set.status = "pending";
      set.startedAt = null;
      set.pausedAt = null;
      set.completedAt = null;
      set.lastError = null;

      if (action === "restart") {
        set.progressCurrent = 0;
        set.lastProcessedId = null;
        set.progressTotal = null;
      }
    }

    await db.update(schema.syncTasks).set(set).where(eq(schema.syncTasks.id, id));

    try {
      await sqlClient.notify(
        TASKS_NOTIFY_CHANNEL,
        JSON.stringify({
          ts: new Date().toISOString(),
          taskId: id,
          sourceChannelId: task.sourceChannelId,
          taskType: task.taskType,
          status: set.status ?? task.status,
        }),
      );
    } catch {
      // ignore notify failures
    }

    return NextResponse.json({ id, action });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: toPublicErrorMessage(error, "更新任务失败") }, { status: 500 });
  }
}
