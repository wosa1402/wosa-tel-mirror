import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";
import { getTrimmedString, toStringOrNull } from "@/lib/utils";

loadEnv();

function formatDateForFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${y}${m}${d}-${hh}${mm}`;
}

type ExportFormat = "txt" | "jsonl";

function parseFormat(value: string): ExportFormat {
  const v = value.trim().toLowerCase();
  if (v === "jsonl" || v === "ndjson") return "jsonl";
  return "txt";
}

export async function GET(request: NextRequest) {
  const authError = await requireApiAuth(request);
  if (authError) return authError;

  const url = new URL(request.url);
  const format = parseFormat(getTrimmedString(url.searchParams.get("format")));

  const now = new Date();
  const stamp = formatDateForFilename(now);

  if (format === "txt") {
    const rows = await db
      .select({
        channelIdentifier: schema.sourceChannels.channelIdentifier,
      })
      .from(schema.sourceChannels)
      .orderBy(desc(schema.sourceChannels.subscribedAt));

    const text =
      rows
        .map((r) => r.channelIdentifier)
        .filter((v) => typeof v === "string" && v.trim())
        .join("\n") + "\n";

    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename=\"tg-back-channels-${stamp}.txt\"`,
      },
    });
  }

  const rows = await db
    .select({
      source: schema.sourceChannels,
      mirror: schema.mirrorChannels,
    })
    .from(schema.sourceChannels)
    .leftJoin(schema.mirrorChannels, eq(schema.mirrorChannels.sourceChannelId, schema.sourceChannels.id))
    .orderBy(desc(schema.sourceChannels.subscribedAt));

  const lines: string[] = [];
  for (const r of rows) {
    lines.push(
      JSON.stringify({
        source: {
          id: r.source.id,
          groupName: r.source.groupName ?? "",
          channelIdentifier: r.source.channelIdentifier,
          telegramId: toStringOrNull(r.source.telegramId),
          accessHash: toStringOrNull(r.source.accessHash),
          name: r.source.name,
          username: r.source.username ?? null,
          description: r.source.description ?? null,
          subscribedAt: r.source.subscribedAt.toISOString(),
          lastSyncAt: r.source.lastSyncAt ? r.source.lastSyncAt.toISOString() : null,
          syncStatus: r.source.syncStatus,
          lastMessageId: r.source.lastMessageId ?? null,
          isProtected: r.source.isProtected,
          memberCount: r.source.memberCount ?? null,
          totalMessages: r.source.totalMessages ?? null,
          mirrorMode: r.source.mirrorMode ?? null,
          isActive: r.source.isActive,
          priority: r.source.priority ?? 0,
        },
        mirror: r.mirror
          ? {
              id: r.mirror.id,
              sourceChannelId: r.mirror.sourceChannelId,
              channelIdentifier: r.mirror.channelIdentifier,
              telegramId: toStringOrNull(r.mirror.telegramId),
              accessHash: toStringOrNull(r.mirror.accessHash),
              name: r.mirror.name,
              username: r.mirror.username ?? null,
              inviteLink: r.mirror.inviteLink ?? null,
              isAutoCreated: r.mirror.isAutoCreated,
              createdAt: r.mirror.createdAt.toISOString(),
            }
          : null,
      }),
    );
  }

  const body = lines.join("\n") + "\n";

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename=\"tg-back-channels-${stamp}.jsonl\"`,
    },
  });
}
