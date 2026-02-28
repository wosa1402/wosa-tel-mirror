import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema, sqlClient, TASKS_NOTIFY_CHANNEL } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { toPublicErrorMessage } from "@/lib/api-error";
import { getTrimmedString } from "@/lib/utils";

loadEnv();

export async function POST(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const channelId = getTrimmedString(body.channelId);

    if (!channelId) return NextResponse.json({ error: "channelId is required" }, { status: 400 });

    const [channel] = await db
      .select({
        id: schema.sourceChannels.id,
        channelIdentifier: schema.sourceChannels.channelIdentifier,
      })
      .from(schema.sourceChannels)
      .where(eq(schema.sourceChannels.id, channelId))
      .limit(1);

    if (!channel) return NextResponse.json({ error: "channel not found" }, { status: 404 });

    const [failedRow] = await db
      .select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.messageMappings)
      .where(and(eq(schema.messageMappings.sourceChannelId, channelId), eq(schema.messageMappings.status, "failed")))
      .limit(1);

    const failedCount = failedRow?.count ?? 0;
    if (!failedCount) {
      return NextResponse.json({
        message: "No failed messages to retry",
        taskCreated: false,
      });
    }

    const [running] = await db
      .select({ id: schema.syncTasks.id, status: schema.syncTasks.status })
      .from(schema.syncTasks)
      .where(
        and(
          eq(schema.syncTasks.sourceChannelId, channelId),
          eq(schema.syncTasks.taskType, "retry_failed"),
          inArray(schema.syncTasks.status, ["pending", "running"]),
        ),
      )
      .orderBy(desc(schema.syncTasks.createdAt))
      .limit(1);

    if (running) {
      return NextResponse.json({
        message: "Retry task already exists",
        taskId: running.id,
        taskCreated: false,
        status: running.status,
      });
    }

    const [existing] = await db
      .select({ id: schema.syncTasks.id })
      .from(schema.syncTasks)
      .where(and(eq(schema.syncTasks.sourceChannelId, channelId), eq(schema.syncTasks.taskType, "retry_failed")))
      .orderBy(desc(schema.syncTasks.createdAt))
      .limit(1);

    if (existing) {
      await db
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
        .where(eq(schema.syncTasks.id, existing.id));

      try {
        await sqlClient.notify(
          TASKS_NOTIFY_CHANNEL,
          JSON.stringify({
            ts: new Date().toISOString(),
            taskId: existing.id,
            sourceChannelId: channelId,
            taskType: "retry_failed",
            status: "pending",
          }),
        );
      } catch {
        // ignore
      }

      return NextResponse.json(
        {
          message: `Retry task requeued (${failedCount} failed messages)`,
          taskId: existing.id,
          taskCreated: true,
        },
        { status: 201 },
      );
    }

    const inserted = await db
      .insert(schema.syncTasks)
      .values({
        sourceChannelId: channelId,
        taskType: "retry_failed",
        status: "pending",
      })
      .onConflictDoNothing()
      .returning({ id: schema.syncTasks.id });

    let taskId = inserted[0]?.id ?? null;
    if (!taskId) {
      const [row] = await db
        .select({ id: schema.syncTasks.id })
        .from(schema.syncTasks)
        .where(and(eq(schema.syncTasks.sourceChannelId, channelId), eq(schema.syncTasks.taskType, "retry_failed")))
        .limit(1);
      taskId = row?.id ?? null;
    }

    if (taskId) {
      try {
        await sqlClient.notify(
          TASKS_NOTIFY_CHANNEL,
          JSON.stringify({
            ts: new Date().toISOString(),
            taskId,
            sourceChannelId: channelId,
            taskType: "retry_failed",
            status: "pending",
          }),
        );
      } catch {
        // ignore
      }
    }

    return NextResponse.json(
      {
        message: `Retry task created (${failedCount} failed messages)`,
        taskId,
        taskCreated: true,
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: toPublicErrorMessage(error, "重试失败消息任务创建失败") }, { status: 500 });
  }
}
