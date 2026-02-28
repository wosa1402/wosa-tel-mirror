import { NextRequest } from "next/server";
import { and, desc, eq, gt, gte, lte, lt, or, sql, type SQL } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
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

type ExportRow = {
  id: string;
  sourceChannelId: string;
  sourceMessageId: number;
  mirrorChannelId: string;
  mirrorMessageId: number | null;
  messageType: (typeof schema.messageTypeEnum.enumValues)[number];
  mediaGroupId: string | null;
  status: (typeof schema.messageStatusEnum.enumValues)[number];
  skipReason: (typeof schema.skipReasonEnum.enumValues)[number] | null;
  errorMessage: string | null;
  retryCount: number;
  hasMedia: boolean;
  fileSize: number | null;
  text: string | null;
  sentAt: Date;
  mirroredAt: Date | null;
  isDeleted: boolean;
  deletedAt: Date | null;
  editCount: number;
  lastEditedAt: Date | null;
  groupSize: number;
};

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const params = url.searchParams;

  const sourceChannelId = getTrimmedString(params.get("sourceChannelId"));
  if (!sourceChannelId) {
    return new Response(JSON.stringify({ error: "Missing sourceChannelId" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

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

  const status = statusRaw ? parseEnumValue(schema.messageStatusEnum.enumValues, statusRaw) : null;
  const messageType = messageTypeRaw ? parseEnumValue(schema.messageTypeEnum.enumValues, messageTypeRaw) : null;
  const startDate = start ? parseDateSafe(start) : null;
  const endDate = end ? parseDateSafe(end) : null;

  const hasMedia = hasMediaRaw ? parseBoolSafe(hasMediaRaw) : null;
  if (hasMediaRaw && hasMedia == null) {
    return new Response(JSON.stringify({ error: "hasMedia must be true|false" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const isDeleted = isDeletedRaw ? parseBoolSafe(isDeletedRaw) : null;
  if (isDeletedRaw && isDeleted == null) {
    return new Response(JSON.stringify({ error: "isDeleted must be true|false" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const edited = editedRaw ? parseBoolSafe(editedRaw) : null;
  if (editedRaw && edited == null) {
    return new Response(JSON.stringify({ error: "edited must be true|false" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const skipReason = skipReasonRaw ? parseEnumValue(schema.skipReasonEnum.enumValues, skipReasonRaw) : null;
  if (skipReasonRaw && !skipReason) {
    return new Response(JSON.stringify({ error: "invalid skipReason" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const minFileSizeMb = minFileSizeMbRaw ? parseIntSafe(minFileSizeMbRaw) : null;
  if (minFileSizeMbRaw && minFileSizeMb == null) {
    return new Response(JSON.stringify({ error: "minFileSizeMb must be an integer" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  const maxFileSizeMb = maxFileSizeMbRaw ? parseIntSafe(maxFileSizeMbRaw) : null;
  if (maxFileSizeMbRaw && maxFileSizeMb == null) {
    return new Response(JSON.stringify({ error: "maxFileSizeMb must be an integer" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const minFileSize = typeof minFileSizeMb === "number" ? Math.max(0, minFileSizeMb) * 1024 * 1024 : null;
  const maxFileSize = typeof maxFileSizeMb === "number" ? Math.max(0, maxFileSizeMb) * 1024 * 1024 : null;
  if (minFileSize != null && maxFileSize != null && minFileSize > maxFileSize) {
    return new Response(JSON.stringify({ error: "minFileSizeMb must be <= maxFileSizeMb" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const [source] = await db
    .select({
      id: schema.sourceChannels.id,
      name: schema.sourceChannels.name,
      channelIdentifier: schema.sourceChannels.channelIdentifier,
      telegramId: schema.sourceChannels.telegramId,
      username: schema.sourceChannels.username,
    })
    .from(schema.sourceChannels)
    .where(eq(schema.sourceChannels.id, sourceChannelId))
    .limit(1);

  if (!source) {
    return new Response(JSON.stringify({ error: `source channel not found: ${sourceChannelId}` }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const [mirror] = await db
    .select({
      id: schema.mirrorChannels.id,
      name: schema.mirrorChannels.name,
      channelIdentifier: schema.mirrorChannels.channelIdentifier,
      telegramId: schema.mirrorChannels.telegramId,
      username: schema.mirrorChannels.username,
    })
    .from(schema.mirrorChannels)
    .where(eq(schema.mirrorChannels.sourceChannelId, sourceChannelId))
    .limit(1);

  if (!mirror) {
    return new Response(JSON.stringify({ error: `mirror channel not found for source: ${sourceChannelId}` }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const baseWhereConditions = [
    eq(schema.messageMappings.sourceChannelId, sourceChannelId),
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

  const grouped = groupMedia
    ? db
        .selectDistinctOn([schema.messageMappings.sourceChannelId, groupKeyExpr], {
          id: schema.messageMappings.id,
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

  const encoder = new TextEncoder();
  const now = new Date();
  const filename = `tg-back_messages_${sourceChannelId}_${now.toISOString().slice(0, 10)}.jsonl`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const meta = {
          type: "meta",
          exportedAt: now.toISOString(),
          sourceChannel: {
            id: source.id,
            name: source.name,
            channelIdentifier: source.channelIdentifier,
            telegramId: toStringOrNull(source.telegramId),
            username: source.username,
          },
          mirrorChannel: {
            id: mirror.id,
            name: mirror.name,
            channelIdentifier: mirror.channelIdentifier,
            telegramId: toStringOrNull(mirror.telegramId),
            username: mirror.username,
          },
          filters: {
            status,
            messageType,
            q: q || null,
            start: startDate ? startDate.toISOString() : null,
            end: endDate ? endDate.toISOString() : null,
            hasMedia,
            isDeleted,
            edited,
            skipReason,
            minFileSizeMb: minFileSizeMb ?? null,
            maxFileSizeMb: maxFileSizeMb ?? null,
            groupMedia,
          },
        };
        controller.enqueue(encoder.encode(`${JSON.stringify(meta)}\n`));

        let cursorSentAt: Date | null = null;
        let cursorSourceMessageId: number | null = null;

        const pageSize = 200;
        for (;;) {
          const cursorWhere: SQL | undefined =
            cursorSentAt && cursorSourceMessageId
              ? grouped
                ? or(
                    lt(grouped.sentAt, cursorSentAt),
                    and(eq(grouped.sentAt, cursorSentAt), lt(grouped.sourceMessageId, cursorSourceMessageId)),
                  )
                : or(
                    lt(schema.messageMappings.sentAt, cursorSentAt),
                    and(
                      eq(schema.messageMappings.sentAt, cursorSentAt),
                      lt(schema.messageMappings.sourceMessageId, cursorSourceMessageId),
                    ),
                  )
              : undefined;

          const rows: ExportRow[] = grouped
            ? ((await db
                .select({
                  id: grouped.id,
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
                  text: grouped.text,
                  sentAt: grouped.sentAt,
                  mirroredAt: grouped.mirroredAt,
                  isDeleted: grouped.isDeleted,
                  deletedAt: grouped.deletedAt,
                  editCount: grouped.editCount,
                  lastEditedAt: grouped.lastEditedAt,
                  groupSize: grouped.groupSize,
                })
                .from(grouped)
                .where(cursorWhere)
                .orderBy(desc(grouped.sentAt), desc(grouped.sourceMessageId))
                .limit(pageSize)) as ExportRow[])
            : ((await db
                .select({
                  id: schema.messageMappings.id,
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
                  text: schema.messageMappings.text,
                  sentAt: schema.messageMappings.sentAt,
                  mirroredAt: schema.messageMappings.mirroredAt,
                  isDeleted: schema.messageMappings.isDeleted,
                  deletedAt: schema.messageMappings.deletedAt,
                  editCount: schema.messageMappings.editCount,
                  lastEditedAt: schema.messageMappings.lastEditedAt,
                  groupSize: sql<number>`1`.mapWith(Number),
                })
                .from(schema.messageMappings)
                .where(and(baseWhere, cursorWhere))
                .orderBy(desc(schema.messageMappings.sentAt), desc(schema.messageMappings.sourceMessageId))
                .limit(pageSize)) as ExportRow[]);

          if (!rows.length) break;

          for (const row of rows) {
            const line = {
              type: "message",
              id: row.id,
              sourceChannelId: row.sourceChannelId,
              sourceMessageId: row.sourceMessageId,
              sourceLink: buildTelegramMessageLink(source, row.sourceMessageId),
              mirrorChannelId: row.mirrorChannelId,
              mirrorMessageId: row.mirrorMessageId,
              mirrorLink: buildTelegramMessageLink(mirror, row.mirrorMessageId),
              messageType: row.messageType,
              mediaGroupId: row.mediaGroupId,
              groupSize: row.groupSize,
              status: row.status,
              skipReason: row.skipReason,
              errorMessage: row.errorMessage,
              retryCount: row.retryCount,
              hasMedia: row.hasMedia,
              fileSize: row.fileSize,
              text: row.text,
              sentAt: row.sentAt ? row.sentAt.toISOString() : null,
              mirroredAt: row.mirroredAt ? row.mirroredAt.toISOString() : null,
              isDeleted: row.isDeleted,
              deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
              editCount: row.editCount,
              lastEditedAt: row.lastEditedAt ? row.lastEditedAt.toISOString() : null,
            };
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          }

          const last: ExportRow = rows[rows.length - 1]!;
          cursorSentAt = last.sentAt ?? null;
          cursorSourceMessageId = last.sourceMessageId ?? null;

          if (rows.length < pageSize) break;
        }

        controller.close();
      } catch (error: unknown) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename=\"${filename}\"`,
      "cache-control": "no-store",
    },
  });
}
