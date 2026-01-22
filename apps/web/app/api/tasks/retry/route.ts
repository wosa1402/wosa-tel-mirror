import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema, sqlClient } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";

loadEnv();

const TASKS_NOTIFY_CHANNEL = "tg_back_sync_tasks_v1";

function getTrimmedString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

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

    const [task] = await db
      .insert(schema.syncTasks)
      .values({
        sourceChannelId: channelId,
        taskType: "retry_failed",
        status: "pending",
      })
      .returning({ id: schema.syncTasks.id });

    if (task?.id) {
      try {
        await sqlClient.notify(
          TASKS_NOTIFY_CHANNEL,
          JSON.stringify({
            ts: new Date().toISOString(),
            taskId: task.id,
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
        taskId: task?.id ?? null,
        taskCreated: true,
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
