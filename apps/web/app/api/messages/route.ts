import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, gte, inArray, lte, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { toPublicErrorMessage } from "@/lib/api-error";
import { ilikeContains } from "@/lib/sql-like";
import { getTrimmedString, parseEnumValue, parseIntSafe, splitKeywords, toStringOrNull } from "@/lib/utils";

loadEnv();

function parseBoolSafe(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return null;
}

function parseDateSafe(value: string): Date | null {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function buildTelegramMessageLink(
  channel: { username?: string | null; telegramId?: bigint | null },
  messageId: number | null,
): string | null {
  if (!messageId) return null;
  const username = typeof channel.username === "string" ? channel.username.trim().replace(/^@/, "") : "";
  if (username) return `https://t.me/${username}/${messageId}`;
  const telegramId = channel.telegramId;
  if (typeof telegramId === "bigint") return `https://t.me/c/${telegramId.toString()}/${messageId}`;
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const url = new URL(request.url);
    const params = url.searchParams;

    const sourceChannelId = getTrimmedString(params.get("sourceChannelId"));
    const groupNameRaw = params.get("groupName") ?? params.get("group_name");
    const hasGroupParam = params.has("groupName") || params.has("group_name");
    const groupName = getTrimmedString(groupNameRaw);
    const statusRaw = getTrimmedString(params.get("status"));
    const messageTypeRaw = getTrimmedString(params.get("messageType"));
    const q = getTrimmedString(params.get("q"));
    const keywords = q ? splitKeywords(q) : [];
    const start = getTrimmedString(params.get("start"));
    const end = getTrimmedString(params.get("end"));

    const hasMediaRaw = getTrimmedString(params.get("hasMedia") ?? params.get("has_media"));
    const isDeletedRaw = getTrimmedString(params.get("isDeleted") ?? params.get("is_deleted") ?? params.get("deleted"));
    const editedRaw = getTrimmedString(params.get("edited"));
    const skipReasonRaw = getTrimmedString(params.get("skipReason") ?? params.get("skip_reason"));
    const minFileSizeMbRaw = getTrimmedString(params.get("minFileSizeMb") ?? params.get("min_file_size_mb"));
    const maxFileSizeMbRaw = getTrimmedString(params.get("maxFileSizeMb") ?? params.get("max_file_size_mb"));

    const groupMediaRaw = getTrimmedString(params.get("groupMedia") ?? params.get("group_media"));
    const groupMedia = groupMediaRaw ? groupMediaRaw.toLowerCase() !== "false" : true;

    const cursorSentAtRaw = getTrimmedString(params.get("cursorSentAt") ?? params.get("cursor_sent_at"));
    const cursorSourceChannelId = getTrimmedString(params.get("cursorSourceChannelId") ?? params.get("cursor_source_channel_id"));
    const cursorSourceMessageIdRaw = getTrimmedString(params.get("cursorSourceMessageId") ?? params.get("cursor_source_message_id"));

    const limitRaw = getTrimmedString(params.get("limit"));
    const limitParsed = limitRaw ? parseIntSafe(limitRaw) : null;
    const limit = Math.min(Math.max(limitParsed ?? 50, 1), 200);
    const fetchLimit = Math.min(limit + 1, 201);

    const status = statusRaw ? parseEnumValue(schema.messageStatusEnum.enumValues, statusRaw) : null;
    const messageType = messageTypeRaw ? parseEnumValue(schema.messageTypeEnum.enumValues, messageTypeRaw) : null;
    const startDate = start ? parseDateSafe(start) : null;
    const endDate = end ? parseDateSafe(end) : null;

    const hasMedia = hasMediaRaw ? parseBoolSafe(hasMediaRaw) : null;
    if (hasMediaRaw && hasMedia == null) {
      return NextResponse.json({ error: "hasMedia must be true|false" }, { status: 400 });
    }

    const isDeleted = isDeletedRaw ? parseBoolSafe(isDeletedRaw) : null;
    if (isDeletedRaw && isDeleted == null) {
      return NextResponse.json({ error: "isDeleted must be true|false" }, { status: 400 });
    }

    const edited = editedRaw ? parseBoolSafe(editedRaw) : null;
    if (editedRaw && edited == null) {
      return NextResponse.json({ error: "edited must be true|false" }, { status: 400 });
    }

    const skipReason = skipReasonRaw ? parseEnumValue(schema.skipReasonEnum.enumValues, skipReasonRaw) : null;
    if (skipReasonRaw && !skipReason) {
      return NextResponse.json({ error: "invalid skipReason" }, { status: 400 });
    }

    const minFileSizeMb = minFileSizeMbRaw ? parseIntSafe(minFileSizeMbRaw) : null;
    if (minFileSizeMbRaw && minFileSizeMb == null) {
      return NextResponse.json({ error: "minFileSizeMb must be an integer" }, { status: 400 });
    }
    const maxFileSizeMb = maxFileSizeMbRaw ? parseIntSafe(maxFileSizeMbRaw) : null;
    if (maxFileSizeMbRaw && maxFileSizeMb == null) {
      return NextResponse.json({ error: "maxFileSizeMb must be an integer" }, { status: 400 });
    }

    const minFileSize = typeof minFileSizeMb === "number" ? Math.max(0, minFileSizeMb) * 1024 * 1024 : null;
    const maxFileSize = typeof maxFileSizeMb === "number" ? Math.max(0, maxFileSizeMb) * 1024 * 1024 : null;
    if (minFileSize != null && maxFileSize != null && minFileSize > maxFileSize) {
      return NextResponse.json({ error: "minFileSizeMb must be <= maxFileSizeMb" }, { status: 400 });
    }

    const cursorSentAt = cursorSentAtRaw ? parseDateSafe(cursorSentAtRaw) : null;
    const cursorSourceMessageId = cursorSourceMessageIdRaw ? parseIntSafe(cursorSourceMessageIdRaw) : null;

    const groupChannelIds =
      !sourceChannelId && hasGroupParam
        ? (
            await db
              .select({ id: schema.sourceChannels.id })
              .from(schema.sourceChannels)
              .where(eq(schema.sourceChannels.groupName, groupName))
          ).map((r) => r.id)
        : null;

    if (!sourceChannelId && hasGroupParam && (!groupChannelIds || groupChannelIds.length === 0)) {
      return NextResponse.json({ items: [], nextCursor: null, grouped: groupMedia });
    }

  const baseWhereConditions = [
    sourceChannelId
      ? eq(schema.messageMappings.sourceChannelId, sourceChannelId)
      : groupChannelIds
        ? inArray(schema.messageMappings.sourceChannelId, groupChannelIds)
        : undefined,
    status ? eq(schema.messageMappings.status, status) : undefined,
    messageType ? eq(schema.messageMappings.messageType, messageType) : undefined,
    ...keywords.map((k) => ilikeContains(schema.messageMappings.text, k)),
    startDate ? gte(schema.messageMappings.sentAt, startDate) : undefined,
    endDate ? lte(schema.messageMappings.sentAt, endDate) : undefined,
    hasMedia != null ? eq(schema.messageMappings.hasMedia, hasMedia) : undefined,
    isDeleted != null ? eq(schema.messageMappings.isDeleted, isDeleted) : undefined,
    edited != null ? (edited ? gt(schema.messageMappings.editCount, 0) : eq(schema.messageMappings.editCount, 0)) : undefined,
    skipReason ? eq(schema.messageMappings.skipReason, skipReason) : undefined,
    minFileSize != null ? gte(schema.messageMappings.fileSize, minFileSize) : undefined,
    maxFileSize != null ? lte(schema.messageMappings.fileSize, maxFileSize) : undefined,
  ];

  const baseWhere = and(...baseWhereConditions);

  const cursorWhereForMappings =
    cursorSentAt && cursorSourceMessageId && (sourceChannelId || cursorSourceChannelId)
      ? sourceChannelId
        ? or(
            lt(schema.messageMappings.sentAt, cursorSentAt),
            and(eq(schema.messageMappings.sentAt, cursorSentAt), lt(schema.messageMappings.sourceMessageId, cursorSourceMessageId)),
          )
        : or(
            lt(schema.messageMappings.sentAt, cursorSentAt),
            and(eq(schema.messageMappings.sentAt, cursorSentAt), lt(schema.messageMappings.sourceChannelId, cursorSourceChannelId)),
            and(
              eq(schema.messageMappings.sentAt, cursorSentAt),
              eq(schema.messageMappings.sourceChannelId, cursorSourceChannelId),
              lt(schema.messageMappings.sourceMessageId, cursorSourceMessageId),
            ),
          )
      : undefined;

  const hasTextExpr = sql<number>`case when ${schema.messageMappings.text} is not null and ${schema.messageMappings.text} <> '' then 1 else 0 end`.mapWith(
    Number,
  );

  const groupKeyExpr = sql<string>`coalesce(${schema.messageMappings.mediaGroupId}, ${schema.messageMappings.sourceMessageId}::text)`;
  const groupPartitionExpr = sql`${schema.messageMappings.sourceChannelId}, ${groupKeyExpr}`;
  const groupSizeExpr = sql<number>`count(*) over (partition by ${schema.messageMappings.sourceChannelId}, ${groupKeyExpr})`
    .mapWith(Number)
    .as("groupSize");
  const groupIsDeletedExpr = sql<boolean>`bool_or(${schema.messageMappings.isDeleted}) over (partition by ${groupPartitionExpr})`
    .mapWith(schema.messageMappings.isDeleted)
    .as("isDeleted");
  const groupDeletedAtExpr = sql<Date | null>`max(${schema.messageMappings.deletedAt}) over (partition by ${groupPartitionExpr})`
    .mapWith(schema.messageMappings.deletedAt)
    .as("deletedAt");
  const groupEditCountExpr = sql<number>`max(${schema.messageMappings.editCount}) over (partition by ${groupPartitionExpr})`
    .mapWith(Number)
    .as("editCount");
  const groupLastEditedAtExpr =
    sql<Date | null>`max(${schema.messageMappings.lastEditedAt}) over (partition by ${groupPartitionExpr})`
      .mapWith(schema.messageMappings.lastEditedAt)
      .as("lastEditedAt");
  const groupEditMappingIdExpr = sql<string>`first_value(${schema.messageMappings.id}) over (partition by ${groupPartitionExpr} order by ${schema.messageMappings.lastEditedAt} desc nulls last, ${schema.messageMappings.editCount} desc, ${schema.messageMappings.sourceMessageId} desc)`
    .mapWith(schema.messageMappings.id)
    .as("editMappingId");

  const grouped = groupMedia
    ? db
        .selectDistinctOn([schema.messageMappings.sourceChannelId, groupKeyExpr], {
          id: schema.messageMappings.id,
          editMappingId: groupEditMappingIdExpr,
          sourceChannelId: schema.messageMappings.sourceChannelId,
          sourceMessageId: schema.messageMappings.sourceMessageId,
          mirrorChannelId: schema.messageMappings.mirrorChannelId,
          mirrorMessageId: schema.messageMappings.mirrorMessageId,
          messageType: schema.messageMappings.messageType,
          mediaGroupId: schema.messageMappings.mediaGroupId,
          status: schema.messageMappings.status,
          skipReason: schema.messageMappings.skipReason,
          errorMessage: schema.messageMappings.errorMessage,
          retryCount: schema.messageMappings.retryCount,
          hasMedia: schema.messageMappings.hasMedia,
          fileSize: schema.messageMappings.fileSize,
          textPreview: schema.messageMappings.textPreview,
          text: schema.messageMappings.text,
          sentAt: schema.messageMappings.sentAt,
          mirroredAt: schema.messageMappings.mirroredAt,
          isDeleted: groupIsDeletedExpr,
          deletedAt: groupDeletedAtExpr,
          editCount: groupEditCountExpr,
          lastEditedAt: groupLastEditedAtExpr,
          groupSize: groupSizeExpr,
        })
        .from(schema.messageMappings)
        .where(baseWhere)
        .orderBy(
          schema.messageMappings.sourceChannelId,
          groupKeyExpr,
          desc(hasTextExpr),
          desc(schema.messageMappings.sourceMessageId),
        )
        .as("m")
    : null;

  const rows = grouped
    ? await (async () => {
        const cursorWhereForGrouped =
          cursorSentAt && cursorSourceMessageId && (sourceChannelId || cursorSourceChannelId)
            ? sourceChannelId
              ? or(
                  lt(grouped.sentAt, cursorSentAt),
                  and(eq(grouped.sentAt, cursorSentAt), lt(grouped.sourceMessageId, cursorSourceMessageId)),
                )
              : or(
                  lt(grouped.sentAt, cursorSentAt),
                  and(eq(grouped.sentAt, cursorSentAt), lt(grouped.sourceChannelId, cursorSourceChannelId)),
                  and(
                    eq(grouped.sentAt, cursorSentAt),
                    eq(grouped.sourceChannelId, cursorSourceChannelId),
                    lt(grouped.sourceMessageId, cursorSourceMessageId),
                  ),
                )
            : undefined;

        return await db
        .select({
          id: grouped.id,
          editMappingId: grouped.editMappingId,
          sourceChannelId: grouped.sourceChannelId,
          sourceMessageId: grouped.sourceMessageId,
          mirrorChannelId: grouped.mirrorChannelId,
          mirrorMessageId: grouped.mirrorMessageId,
          messageType: grouped.messageType,
          mediaGroupId: grouped.mediaGroupId,
          status: grouped.status,
          skipReason: grouped.skipReason,
          errorMessage: grouped.errorMessage,
          retryCount: grouped.retryCount,
          hasMedia: grouped.hasMedia,
          fileSize: grouped.fileSize,
          textPreview: grouped.textPreview,
          text: grouped.text,
          sentAt: grouped.sentAt,
          mirroredAt: grouped.mirroredAt,
          isDeleted: grouped.isDeleted,
          deletedAt: grouped.deletedAt,
          editCount: grouped.editCount,
          lastEditedAt: grouped.lastEditedAt,
          groupSize: grouped.groupSize,
          sourceId: schema.sourceChannels.id,
          sourceChannelIdentifier: schema.sourceChannels.channelIdentifier,
          sourceTelegramId: schema.sourceChannels.telegramId,
          sourceUsername: schema.sourceChannels.username,
          sourceName: schema.sourceChannels.name,
          mirrorId: schema.mirrorChannels.id,
          mirrorChannelIdentifier: schema.mirrorChannels.channelIdentifier,
          mirrorTelegramId: schema.mirrorChannels.telegramId,
          mirrorUsername: schema.mirrorChannels.username,
          mirrorName: schema.mirrorChannels.name,
        })
        .from(grouped)
        .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, grouped.sourceChannelId))
        .innerJoin(schema.mirrorChannels, eq(schema.mirrorChannels.id, grouped.mirrorChannelId))
        .where(cursorWhereForGrouped)
        .orderBy(desc(grouped.sentAt), desc(grouped.sourceChannelId), desc(grouped.sourceMessageId))
        .limit(fetchLimit);
      })()
    : await db
        .select({
          id: schema.messageMappings.id,
          editMappingId: schema.messageMappings.id,
          sourceChannelId: schema.messageMappings.sourceChannelId,
          sourceMessageId: schema.messageMappings.sourceMessageId,
          mirrorChannelId: schema.messageMappings.mirrorChannelId,
          mirrorMessageId: schema.messageMappings.mirrorMessageId,
          messageType: schema.messageMappings.messageType,
          mediaGroupId: schema.messageMappings.mediaGroupId,
          status: schema.messageMappings.status,
          skipReason: schema.messageMappings.skipReason,
          errorMessage: schema.messageMappings.errorMessage,
          retryCount: schema.messageMappings.retryCount,
          hasMedia: schema.messageMappings.hasMedia,
          fileSize: schema.messageMappings.fileSize,
          textPreview: schema.messageMappings.textPreview,
          text: schema.messageMappings.text,
          sentAt: schema.messageMappings.sentAt,
          mirroredAt: schema.messageMappings.mirroredAt,
          isDeleted: schema.messageMappings.isDeleted,
          deletedAt: schema.messageMappings.deletedAt,
          editCount: schema.messageMappings.editCount,
          lastEditedAt: schema.messageMappings.lastEditedAt,
          groupSize: groupSizeExpr,
          sourceId: schema.sourceChannels.id,
          sourceChannelIdentifier: schema.sourceChannels.channelIdentifier,
          sourceTelegramId: schema.sourceChannels.telegramId,
          sourceUsername: schema.sourceChannels.username,
          sourceName: schema.sourceChannels.name,
          mirrorId: schema.mirrorChannels.id,
          mirrorChannelIdentifier: schema.mirrorChannels.channelIdentifier,
          mirrorTelegramId: schema.mirrorChannels.telegramId,
          mirrorUsername: schema.mirrorChannels.username,
          mirrorName: schema.mirrorChannels.name,
        })
        .from(schema.messageMappings)
        .innerJoin(schema.sourceChannels, eq(schema.sourceChannels.id, schema.messageMappings.sourceChannelId))
        .innerJoin(schema.mirrorChannels, eq(schema.mirrorChannels.id, schema.messageMappings.mirrorChannelId))
        .where(and(baseWhere, cursorWhereForMappings))
        .orderBy(desc(schema.messageMappings.sentAt), desc(schema.messageMappings.sourceChannelId), desc(schema.messageMappings.sourceMessageId))
        .limit(fetchLimit);

  type Row = (typeof rows)[number];

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.length ? items[items.length - 1] : null;

  const nextCursor =
    hasMore && last
      ? {
          sentAt: last.sentAt.toISOString(),
          sourceChannelId: last.sourceChannelId,
          sourceMessageId: last.sourceMessageId,
        }
      : null;

    return NextResponse.json({
      items: items.map((r: Row) => ({
        id: r.id,
        editMappingId: r.editMappingId ?? r.id,
        sourceChannelId: r.sourceChannelId,
        sourceMessageId: r.sourceMessageId,
        mirrorChannelId: r.mirrorChannelId,
        mirrorMessageId: r.mirrorMessageId,
        messageType: r.messageType,
        mediaGroupId: r.mediaGroupId,
        groupSize: typeof r.groupSize === "number" ? r.groupSize : 1,
        status: r.status,
        skipReason: r.skipReason,
        errorMessage: r.errorMessage,
        retryCount: r.retryCount,
        hasMedia: r.hasMedia,
        fileSize: r.fileSize ?? null,
        textPreview: r.textPreview,
        text: r.text,
        sentAt: r.sentAt.toISOString(),
        mirroredAt: r.mirroredAt ? r.mirroredAt.toISOString() : null,
        isDeleted: r.isDeleted,
        deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
        editCount: r.editCount,
        lastEditedAt: r.lastEditedAt ? r.lastEditedAt.toISOString() : null,
        sourceChannel: {
          id: r.sourceId,
          channelIdentifier: r.sourceChannelIdentifier,
          telegramId: toStringOrNull(r.sourceTelegramId),
          username: r.sourceUsername,
          name: r.sourceName,
        },
        mirrorChannel: {
          id: r.mirrorId,
          channelIdentifier: r.mirrorChannelIdentifier,
          telegramId: toStringOrNull(r.mirrorTelegramId),
          username: r.mirrorUsername,
          name: r.mirrorName,
        },
        links: {
          source: buildTelegramMessageLink({ username: r.sourceUsername, telegramId: r.sourceTelegramId }, r.sourceMessageId),
          mirror: buildTelegramMessageLink({ username: r.mirrorUsername, telegramId: r.mirrorTelegramId }, r.mirrorMessageId),
        },
      })),
      nextCursor,
      grouped: groupMedia,
    });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: toPublicErrorMessage(error, "加载消息失败") }, { status: 500 });
  }
}
