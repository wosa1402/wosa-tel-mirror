import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema, sqlClient } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";

loadEnv();

const TASKS_NOTIFY_CHANNEL = "tg_back_sync_tasks_v1";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isMissingColumnError(error: unknown, columnName: string): boolean {
  const anyError = error as { cause?: unknown } | null;
  const cause = anyError?.cause as { code?: unknown; message?: unknown } | null;
  if (!cause) return false;
  if (cause.code !== "42703") return false;
  if (typeof cause.message !== "string") return false;
  return cause.message.includes(columnName) && cause.message.toLowerCase().includes("does not exist");
}

function getTrimmedString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeGroupName(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") return undefined;
  return value.trim().slice(0, 50);
}

function isMirrorMode(value: unknown): value is "forward" | "copy" {
  return value === "forward" || value === "copy";
}

function isMessageFilterMode(value: unknown): value is (typeof schema.messageFilterModeEnum.enumValues)[number] {
  return value === "inherit" || value === "disabled" || value === "custom";
}

type MirrorTarget = "manual" | "auto";

function toMirrorTarget(value: unknown): MirrorTarget {
  return value === "auto" ? "auto" : "manual";
}

function toStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "string") return value;
  return String(value);
}

function getBooleanOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

function getIntOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-100, Math.min(100, Math.trunc(value)));
}

async function getDefaultMirrorMode(): Promise<"forward" | "copy"> {
  try {
    const [row] = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, "default_mirror_mode"))
      .limit(1);
    const raw = row?.value;
    return raw === "copy" ? "copy" : "forward";
  } catch {
    return "forward";
  }
}

async function ensureTasks(sourceChannelId: string): Promise<void> {
  const existing = await db
    .select({ id: schema.syncTasks.id, taskType: schema.syncTasks.taskType, status: schema.syncTasks.status })
    .from(schema.syncTasks)
    .where(eq(schema.syncTasks.sourceChannelId, sourceChannelId));

  const values: Array<typeof schema.syncTasks.$inferInsert> = [];

  const resolve = existing.find((t) => t.taskType === "resolve");
  const historyFull = existing.find((t) => t.taskType === "history_full");
  const realtime = existing.find((t) => t.taskType === "realtime");

  if (!resolve) values.push({ sourceChannelId, taskType: "resolve" });
  if (!historyFull) values.push({ sourceChannelId, taskType: "history_full" });
  if (!realtime) values.push({ sourceChannelId, taskType: "realtime" });

  if (values.length) {
    await db.insert(schema.syncTasks).values(values);
  }

  if (resolve?.status === "failed" || resolve?.status === "paused") {
    await db
      .update(schema.syncTasks)
      .set({ status: "pending", lastError: null, startedAt: null, completedAt: null, pausedAt: null })
      .where(eq(schema.syncTasks.id, resolve.id));
  }
  if (historyFull?.status === "failed" || historyFull?.status === "paused") {
    await db
      .update(schema.syncTasks)
      .set({ status: "pending", lastError: null, startedAt: null, completedAt: null, pausedAt: null })
      .where(eq(schema.syncTasks.id, historyFull.id));
  }
  if (realtime?.status === "failed" || realtime?.status === "paused") {
    await db
      .update(schema.syncTasks)
      .set({ status: "pending", lastError: null, startedAt: null, completedAt: null, pausedAt: null })
      .where(eq(schema.syncTasks.id, realtime.id));
  }

  try {
    await sqlClient.notify(
      TASKS_NOTIFY_CHANNEL,
      JSON.stringify({
        ts: new Date().toISOString(),
        sourceChannelId,
      }),
    );
  } catch {
    // ignore
  }
}

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  try {
    const url = new URL(request.url);
    const id = getTrimmedString(url.searchParams.get("id"));
    const mode = getTrimmedString(url.searchParams.get("mode"));

    if (mode === "options") {
      const rows = id
        ? await db
            .select({
              id: schema.sourceChannels.id,
              groupName: schema.sourceChannels.groupName,
              channelIdentifier: schema.sourceChannels.channelIdentifier,
              telegramId: schema.sourceChannels.telegramId,
              name: schema.sourceChannels.name,
              username: schema.sourceChannels.username,
              subscribedAt: schema.sourceChannels.subscribedAt,
            })
            .from(schema.sourceChannels)
            .where(eq(schema.sourceChannels.id, id))
            .orderBy(desc(schema.sourceChannels.subscribedAt))
        : await db
            .select({
              id: schema.sourceChannels.id,
              groupName: schema.sourceChannels.groupName,
              channelIdentifier: schema.sourceChannels.channelIdentifier,
              telegramId: schema.sourceChannels.telegramId,
              name: schema.sourceChannels.name,
              username: schema.sourceChannels.username,
              subscribedAt: schema.sourceChannels.subscribedAt,
            })
            .from(schema.sourceChannels)
            .orderBy(desc(schema.sourceChannels.subscribedAt));

      return NextResponse.json({
        channels: rows.map((r) => ({
          id: r.id,
          groupName: r.groupName,
          channelIdentifier: r.channelIdentifier,
          telegramId: toStringOrNull(r.telegramId),
          name: r.name,
          username: r.username,
        })),
      });
    }

    const rows = id
      ? await db
          .select({
            source: schema.sourceChannels,
            mirror: schema.mirrorChannels,
          })
          .from(schema.sourceChannels)
          .leftJoin(schema.mirrorChannels, eq(schema.mirrorChannels.sourceChannelId, schema.sourceChannels.id))
          .where(eq(schema.sourceChannels.id, id))
          .orderBy(desc(schema.sourceChannels.subscribedAt))
      : await db
          .select({
            source: schema.sourceChannels,
            mirror: schema.mirrorChannels,
          })
          .from(schema.sourceChannels)
          .leftJoin(schema.mirrorChannels, eq(schema.mirrorChannels.sourceChannelId, schema.sourceChannels.id))
          .orderBy(desc(schema.sourceChannels.subscribedAt));

    const sourceChannelIds = rows.map((r) => r.source.id);
    const tasks = sourceChannelIds.length
      ? await db
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
          })
          .from(schema.syncTasks)
          .where(inArray(schema.syncTasks.sourceChannelId, sourceChannelIds))
          .orderBy(desc(schema.syncTasks.createdAt))
      : [];

    const mappingStatsRows = sourceChannelIds.length
      ? await db
          .select({
            sourceChannelId: schema.messageMappings.sourceChannelId,
            status: schema.messageMappings.status,
            skipReason: schema.messageMappings.skipReason,
            count: sql<number>`count(*)`.mapWith(Number),
          })
          .from(schema.messageMappings)
          .where(inArray(schema.messageMappings.sourceChannelId, sourceChannelIds))
          .groupBy(schema.messageMappings.sourceChannelId, schema.messageMappings.status, schema.messageMappings.skipReason)
      : [];

    const latestEvents = sourceChannelIds.length
      ? await db
          .selectDistinctOn([schema.syncEvents.sourceChannelId], {
            id: schema.syncEvents.id,
            sourceChannelId: schema.syncEvents.sourceChannelId,
            level: schema.syncEvents.level,
            message: schema.syncEvents.message,
            createdAt: schema.syncEvents.createdAt,
          })
          .from(schema.syncEvents)
          .where(inArray(schema.syncEvents.sourceChannelId, sourceChannelIds))
          .orderBy(schema.syncEvents.sourceChannelId, desc(schema.syncEvents.createdAt), desc(schema.syncEvents.id))
      : [];

    const latestErrorEvents = sourceChannelIds.length
      ? await db
          .selectDistinctOn([schema.syncEvents.sourceChannelId], {
            id: schema.syncEvents.id,
            sourceChannelId: schema.syncEvents.sourceChannelId,
            level: schema.syncEvents.level,
            message: schema.syncEvents.message,
            createdAt: schema.syncEvents.createdAt,
          })
          .from(schema.syncEvents)
          .where(and(inArray(schema.syncEvents.sourceChannelId, sourceChannelIds), eq(schema.syncEvents.level, "error")))
          .orderBy(schema.syncEvents.sourceChannelId, desc(schema.syncEvents.createdAt), desc(schema.syncEvents.id))
      : [];

  const tasksBySource = new Map<
    string,
    Partial<
      Record<
        (typeof schema.taskTypeEnum.enumValues)[number],
        {
          id: string;
          status: (typeof schema.taskStatusEnum.enumValues)[number];
          progressCurrent: number;
          progressTotal: number | null;
          lastProcessedId: number | null;
          lastError: string | null;
          createdAt: Date;
          startedAt: Date | null;
          completedAt: Date | null;
          pausedAt: Date | null;
        }
      >
    >
  >();

  for (const t of tasks) {
    const existing = tasksBySource.get(t.sourceChannelId) ?? {};
    if (!existing[t.taskType]) {
      existing[t.taskType] = {
        id: t.id,
        status: t.status,
        progressCurrent: t.progressCurrent,
        progressTotal: t.progressTotal,
        lastProcessedId: t.lastProcessedId,
        lastError: t.lastError,
        createdAt: t.createdAt,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        pausedAt: t.pausedAt,
      };
      tasksBySource.set(t.sourceChannelId, existing);
    }
  }

  const mappingStatsBySource = new Map<
    string,
    {
      total: number;
      pending: number;
      success: number;
      failed: number;
      skipped: number;
      skippedProtectedContent: number;
    }
  >();

  for (const row of mappingStatsRows) {
    const current =
      mappingStatsBySource.get(row.sourceChannelId) ?? {
        total: 0,
        pending: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        skippedProtectedContent: 0,
      };
    current.total += row.count;
    if (row.status === "pending") current.pending += row.count;
    if (row.status === "success") current.success += row.count;
    if (row.status === "failed") current.failed += row.count;
    if (row.status === "skipped") {
      current.skipped += row.count;
      if (row.skipReason === "protected_content") current.skippedProtectedContent += row.count;
    }
    mappingStatsBySource.set(row.sourceChannelId, current);
  }

  const lastEventBySource = new Map<
    string,
    { id: string; level: (typeof schema.eventLevelEnum.enumValues)[number]; message: string; createdAt: Date }
  >();
  for (const e of latestEvents) {
    if (!e.sourceChannelId) continue;
    lastEventBySource.set(e.sourceChannelId, { id: e.id, level: e.level, message: e.message, createdAt: e.createdAt });
  }

  const lastErrorEventBySource = new Map<
    string,
    { id: string; level: (typeof schema.eventLevelEnum.enumValues)[number]; message: string; createdAt: Date }
  >();
  for (const e of latestErrorEvents) {
    if (!e.sourceChannelId) continue;
    lastErrorEventBySource.set(e.sourceChannelId, { id: e.id, level: e.level, message: e.message, createdAt: e.createdAt });
  }

    return NextResponse.json({
      channels: rows.map((r) => ({
        id: r.source.id,
        groupName: r.source.groupName,
        channelIdentifier: r.source.channelIdentifier,
        telegramId: toStringOrNull(r.source.telegramId),
        accessHash: toStringOrNull(r.source.accessHash),
        name: r.source.name,
        username: r.source.username,
        description: r.source.description,
        memberCount: r.source.memberCount,
        totalMessages: r.source.totalMessages,
        syncStatus: r.source.syncStatus,
        lastSyncAt: r.source.lastSyncAt,
        lastMessageId: r.source.lastMessageId,
        isActive: r.source.isActive,
        isProtected: r.source.isProtected,
        mirrorMode: r.source.mirrorMode,
        priority: r.source.priority,
        messageFilterMode: r.source.messageFilterMode,
        messageFilterKeywords: r.source.messageFilterKeywords,
        tasks: tasksBySource.get(r.source.id) ?? {},
        messageStats:
          mappingStatsBySource.get(r.source.id) ??
          ({
            total: 0,
            pending: 0,
            success: 0,
            failed: 0,
            skipped: 0,
            skippedProtectedContent: 0,
          } as const),
        lastEvent: lastEventBySource.get(r.source.id) ?? null,
        lastErrorEvent: lastErrorEventBySource.get(r.source.id) ?? null,
        mirrorChannel: r.mirror
          ? {
              id: r.mirror.id,
              channelIdentifier: r.mirror.channelIdentifier,
              telegramId: toStringOrNull(r.mirror.telegramId),
              accessHash: toStringOrNull(r.mirror.accessHash),
              name: r.mirror.name,
              username: r.mirror.username,
              inviteLink: r.mirror.inviteLink,
              isAutoCreated: r.mirror.isAutoCreated,
            }
          : null,
      })),
    });
  } catch (e: unknown) {
    if (isMissingColumnError(e, "source_channels.group_name")) {
      return NextResponse.json(
        {
          error: "数据库还没执行最新迁移（缺少 group_name 字段）。请在项目根目录运行 pnpm db:migrate，然后重启 pnpm dev:web。",
        },
        { status: 500 },
      );
    }
    if (isMissingColumnError(e, "source_channels.message_filter_mode") || isMissingColumnError(e, "source_channels.message_filter_keywords")) {
      return NextResponse.json(
        {
          error:
            "数据库还没执行最新迁移（缺少 message_filter_mode/message_filter_keywords 字段）。请在项目根目录运行 pnpm db:migrate，然后重启 pnpm dev:web。",
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: `Failed to load channels: ${getErrorMessage(e)}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const groupName = normalizeGroupName((body as { groupName?: unknown }).groupName);
    const sourceChannelIdentifier = getTrimmedString(body.sourceChannelIdentifier);
    const mirrorTarget = toMirrorTarget(body.mirrorTarget);
    const mirrorChannelIdentifier = getTrimmedString(body.mirrorChannelIdentifier) || "me";
    const mirrorMode = isMirrorMode(body.mirrorMode) ? body.mirrorMode : undefined;
    const defaultMirrorMode = mirrorMode ? null : await getDefaultMirrorMode();
    const effectiveMirrorMode = mirrorMode ?? defaultMirrorMode ?? "forward";
    const priorityInput = getIntOrUndefined(body.priority);
    const priority = clampPriority(priorityInput ?? 0);

    if (!sourceChannelIdentifier) {
      return NextResponse.json({ error: "sourceChannelIdentifier is required" }, { status: 400 });
    }

    const [existing] = await db
      .select()
      .from(schema.sourceChannels)
      .where(eq(schema.sourceChannels.channelIdentifier, sourceChannelIdentifier))
      .limit(1);

    if (existing) {
      const [mirror] = await db
        .select()
        .from(schema.mirrorChannels)
        .where(eq(schema.mirrorChannels.sourceChannelId, existing.id))
        .limit(1);

      if (mirrorTarget === "auto" && mirror && !mirror.isAutoCreated) {
        return NextResponse.json(
          {
            error:
              "该源频道已绑定了镜像频道，暂不支持切换为“自动创建镜像频道”。请先删除该源频道记录后重新添加。",
          },
          { status: 400 },
        );
      }

      if (!mirror) {
        await db.insert(schema.mirrorChannels).values({
          sourceChannelId: existing.id,
          channelIdentifier: mirrorTarget === "auto" ? "auto" : mirrorChannelIdentifier,
          name: mirrorTarget === "auto" ? "auto" : mirrorChannelIdentifier,
          isAutoCreated: mirrorTarget === "auto",
        });
      } else if (mirrorTarget !== "auto" && mirror.channelIdentifier !== mirrorChannelIdentifier) {
        await db
          .update(schema.mirrorChannels)
          .set({ channelIdentifier: mirrorChannelIdentifier, isAutoCreated: false })
          .where(eq(schema.mirrorChannels.id, mirror.id));
      }

      if (mirrorMode) {
        await db
          .update(schema.sourceChannels)
          .set({ mirrorMode })
          .where(eq(schema.sourceChannels.id, existing.id));
      }

      await ensureTasks(existing.id);

      // 用户手动点“重试/重新添加”时，通常希望能立刻再次调度任务；
      // 如果之前因为 resolve/history_full 失败导致 syncStatus=error，这里把它恢复为 pending。
      if (existing.syncStatus === "error") {
        await db
          .update(schema.sourceChannels)
          .set({ syncStatus: "pending" })
          .where(eq(schema.sourceChannels.id, existing.id));
      }

      return NextResponse.json({ id: existing.id, alreadyExists: true });
    }

    const [source] = await db
      .insert(schema.sourceChannels)
      .values({
        channelIdentifier: sourceChannelIdentifier,
        groupName: groupName ?? "",
        name: sourceChannelIdentifier,
        mirrorMode: effectiveMirrorMode,
        syncStatus: "pending",
        isActive: true,
        priority,
        isProtected: false,
      })
      .returning();

    await db.insert(schema.mirrorChannels).values({
      sourceChannelId: source.id,
      channelIdentifier: mirrorTarget === "auto" ? "auto" : mirrorChannelIdentifier,
      name: mirrorTarget === "auto" ? "auto" : mirrorChannelIdentifier,
      isAutoCreated: mirrorTarget === "auto",
    });

    await ensureTasks(source.id);

    return NextResponse.json({ id: source.id, alreadyExists: false });
  } catch (e: unknown) {
    if (isMissingColumnError(e, "source_channels.group_name")) {
      return NextResponse.json(
        {
          error: "数据库还没执行最新迁移（缺少 group_name 字段）。请在项目根目录运行 pnpm db:migrate，然后重启 pnpm dev:web。",
        },
        { status: 500 },
      );
    }
    if (isMissingColumnError(e, "source_channels.message_filter_mode") || isMissingColumnError(e, "source_channels.message_filter_keywords")) {
      return NextResponse.json(
        {
          error:
            "数据库还没执行最新迁移（缺少 message_filter_mode/message_filter_keywords 字段）。请在项目根目录运行 pnpm db:migrate，然后重启 pnpm dev:web。",
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: `Failed to create channel: ${getErrorMessage(e)}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const id = getTrimmedString(body.id);
    const isActive = getBooleanOrUndefined(body.isActive);
    const groupName = normalizeGroupName((body as { groupName?: unknown }).groupName);
    const priorityInput = getIntOrUndefined(body.priority);
    const priority = priorityInput == null ? undefined : clampPriority(priorityInput);
    const mirrorModeRaw = (body as { mirrorMode?: unknown }).mirrorMode;
    const mirrorMode = isMirrorMode(mirrorModeRaw) ? mirrorModeRaw : undefined;
    const recoverSyncStatus = getBooleanOrUndefined((body as { recoverSyncStatus?: unknown }).recoverSyncStatus);

    const messageFilterModeRaw = (body as { messageFilterMode?: unknown }).messageFilterMode;
    const messageFilterMode = isMessageFilterMode(messageFilterModeRaw) ? messageFilterModeRaw : undefined;

    const hasMessageFilterKeywords = Object.prototype.hasOwnProperty.call(body as Record<string, unknown>, "messageFilterKeywords");
    const messageFilterKeywordsRaw = (body as { messageFilterKeywords?: unknown }).messageFilterKeywords;
    const messageFilterKeywords =
      typeof messageFilterKeywordsRaw === "string" ? messageFilterKeywordsRaw.trim().slice(0, 5000) : undefined;

    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    if (mirrorModeRaw != null && mirrorMode == null) {
      return NextResponse.json({ error: "mirrorMode must be forward|copy" }, { status: 400 });
    }
    if (messageFilterModeRaw != null && messageFilterMode == null) {
      return NextResponse.json({ error: "messageFilterMode must be inherit|disabled|custom" }, { status: 400 });
    }
    if (hasMessageFilterKeywords && typeof messageFilterKeywordsRaw !== "string") {
      return NextResponse.json({ error: "messageFilterKeywords must be string" }, { status: 400 });
    }
    if (
      isActive == null &&
      groupName == null &&
      priority == null &&
      mirrorMode == null &&
      messageFilterMode == null &&
      !hasMessageFilterKeywords &&
      recoverSyncStatus !== true
    ) {
      return NextResponse.json(
        {
          error:
            "isActive or groupName or priority or mirrorMode or messageFilterMode or messageFilterKeywords or recoverSyncStatus is required",
        },
        { status: 400 },
      );
    }

    const [existing] = await db.select().from(schema.sourceChannels).where(eq(schema.sourceChannels.id, id)).limit(1);
    if (!existing) return NextResponse.json({ error: "channel not found" }, { status: 404 });

    const updates: Partial<typeof schema.sourceChannels.$inferInsert> = {};
    if (isActive != null) updates.isActive = isActive;
    if (groupName != null) updates.groupName = groupName;
    if (priority != null) updates.priority = priority;
    if (mirrorMode != null) updates.mirrorMode = mirrorMode;
    if (messageFilterMode != null) updates.messageFilterMode = messageFilterMode;
    if (hasMessageFilterKeywords) updates.messageFilterKeywords = messageFilterKeywords ?? "";
    if (recoverSyncStatus === true) updates.syncStatus = "pending";

    await db.update(schema.sourceChannels).set(updates).where(eq(schema.sourceChannels.id, id));

    if (isActive === false) {
      await db
        .update(schema.syncTasks)
        .set({ status: "paused", pausedAt: new Date(), lastError: "paused by user" })
        .where(and(eq(schema.syncTasks.sourceChannelId, id), inArray(schema.syncTasks.status, ["pending", "running"])));
    } else if (isActive === true) {
      await db
        .update(schema.syncTasks)
        .set({ status: "pending", pausedAt: null, lastError: null, completedAt: null })
        .where(and(eq(schema.syncTasks.sourceChannelId, id), eq(schema.syncTasks.status, "paused")));
      await ensureTasks(id);

      // 启用时如果频道处于 error，也恢复为 pending，允许 mirror-service 再次尝试调度。
      await db
        .update(schema.sourceChannels)
        .set({ syncStatus: "pending" })
        .where(and(eq(schema.sourceChannels.id, id), eq(schema.sourceChannels.syncStatus, "error")));
    }

    if (recoverSyncStatus === true) {
      await ensureTasks(id);
    }

    return NextResponse.json({
      id,
      isActive: isActive ?? existing.isActive,
      groupName: groupName ?? existing.groupName,
      priority: priority ?? existing.priority,
      mirrorMode: mirrorMode ?? existing.mirrorMode,
      messageFilterMode: messageFilterMode ?? existing.messageFilterMode,
      messageFilterKeywords: hasMessageFilterKeywords ? messageFilterKeywords ?? "" : existing.messageFilterKeywords,
      syncStatus: (updates.syncStatus as string | undefined) ?? existing.syncStatus,
    });
  } catch (e: unknown) {
    if (isMissingColumnError(e, "source_channels.group_name")) {
      return NextResponse.json(
        {
          error: "数据库还没执行最新迁移（缺少 group_name 字段）。请在项目根目录运行 pnpm db:migrate，然后重启 pnpm dev:web。",
        },
        { status: 500 },
      );
    }
    if (isMissingColumnError(e, "source_channels.message_filter_mode") || isMissingColumnError(e, "source_channels.message_filter_keywords")) {
      return NextResponse.json(
        {
          error:
            "数据库还没执行最新迁移（缺少 message_filter_mode/message_filter_keywords 字段）。请在项目根目录运行 pnpm db:migrate，然后重启 pnpm dev:web。",
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: `Failed to update channel: ${getErrorMessage(e)}` }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json().catch(() => ({}));
    const id = getTrimmedString(body.id);
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    const deleted = await db
      .delete(schema.sourceChannels)
      .where(eq(schema.sourceChannels.id, id))
      .returning({ id: schema.sourceChannels.id });

    if (!deleted.length) return NextResponse.json({ error: "channel not found" }, { status: 404 });
    return NextResponse.json({ id });
  } catch (e: unknown) {
    if (isMissingColumnError(e, "source_channels.group_name")) {
      return NextResponse.json(
        {
          error: "数据库还没执行最新迁移（缺少 group_name 字段）。请在项目根目录运行 pnpm db:migrate，然后重启 pnpm dev:web。",
        },
        { status: 500 },
      );
    }
    if (isMissingColumnError(e, "source_channels.message_filter_mode") || isMissingColumnError(e, "source_channels.message_filter_keywords")) {
      return NextResponse.json(
        {
          error:
            "数据库还没执行最新迁移（缺少 message_filter_mode/message_filter_keywords 字段）。请在项目根目录运行 pnpm db:migrate，然后重启 pnpm dev:web。",
        },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: `Failed to delete channel: ${getErrorMessage(e)}` }, { status: 500 });
  }
}
