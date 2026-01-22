import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";

loadEnv();

const SETTINGS_KEY = "ui_presets_v1";
const MAX_PRESETS_PER_SCOPE = 50;

type PresetScope = "messages" | "tasks" | "events" | "channels";

const SCOPES: PresetScope[] = ["messages", "tasks", "events", "channels"];

type QueryPreset = {
  id: string;
  name: string;
  query: string;
  createdAt: number;
};

type UiPresetsValue = {
  version: 1;
  messages: QueryPreset[];
  tasks: QueryPreset[];
  events: QueryPreset[];
  channels: QueryPreset[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeTrim(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function clampName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 50);
}

function clampQuery(value: string): string {
  return value.trim().slice(0, 8000);
}

function safeParsePresetList(input: unknown): QueryPreset[] {
  if (!Array.isArray(input)) return [];
  const out: QueryPreset[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const id = safeTrim(item.id);
    const name = clampName(safeTrim(item.name));
    const query = clampQuery(safeTrim(item.query));
    const createdAtRaw = item.createdAt;
    const createdAt =
      typeof createdAtRaw === "number" && Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.trunc(createdAtRaw) : 0;
    if (!name) continue;
    out.push({ id: id || crypto.randomUUID(), name, query, createdAt: createdAt || Date.now() });
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, MAX_PRESETS_PER_SCOPE);
}

function emptyValue(): UiPresetsValue {
  return { version: 1, messages: [], tasks: [], events: [], channels: [] };
}

function normalizeValue(raw: unknown): UiPresetsValue {
  if (!isRecord(raw)) return emptyValue();
  return {
    version: 1,
    messages: safeParsePresetList(raw.messages),
    tasks: safeParsePresetList(raw.tasks),
    events: safeParsePresetList(raw.events),
    channels: safeParsePresetList(raw.channels),
  };
}

function buildSignature(p: Pick<QueryPreset, "name" | "query">): string {
  return `${p.name.trim().toLowerCase()}|${p.query.trim()}`;
}

async function loadCurrent(): Promise<UiPresetsValue> {
  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, SETTINGS_KEY))
    .limit(1);
  return normalizeValue(row?.value);
}

async function saveValue(value: UiPresetsValue): Promise<void> {
  await db
    .insert(schema.settings)
    .values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value },
    });
}

export async function POST(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const modeRaw = safeTrim(body?.mode).toLowerCase();
    const mode: "merge" | "replace" = modeRaw === "replace" ? "replace" : "merge";

    const presetsByScopeRaw = body?.presetsByScope ?? body?.presets ?? body?.data ?? null;
    if (!isRecord(presetsByScopeRaw)) {
      return NextResponse.json({ error: "presetsByScope must be an object" }, { status: 400 });
    }

    const imported: UiPresetsValue = {
      version: 1,
      messages: safeParsePresetList(presetsByScopeRaw.messages),
      tasks: safeParsePresetList(presetsByScopeRaw.tasks),
      events: safeParsePresetList(presetsByScopeRaw.events),
      channels: safeParsePresetList(presetsByScopeRaw.channels),
    };

    const current = await loadCurrent();

    if (mode === "replace") {
      await saveValue(imported);
      return NextResponse.json({
        success: true,
        mode,
        counts: Object.fromEntries(SCOPES.map((s) => [s, imported[s].length])),
      });
    }

    const merged: UiPresetsValue = { ...current };

    for (const scope of SCOPES) {
      const existing = current[scope];
      const incoming = imported[scope];
      const map = new Map<string, QueryPreset>();

      for (const p of existing) map.set(buildSignature(p), p);
      for (const p of incoming) {
        const sig = buildSignature(p);
        if (!sig) continue;
        if (!map.has(sig)) map.set(sig, p);
      }

      merged[scope] = Array.from(map.values())
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .slice(0, MAX_PRESETS_PER_SCOPE);
    }

    await saveValue(merged);

    const beforeCounts = Object.fromEntries(SCOPES.map((s) => [s, current[s].length]));
    const afterCounts = Object.fromEntries(SCOPES.map((s) => [s, merged[s].length]));

    return NextResponse.json({ success: true, mode, beforeCounts, afterCounts });
  } catch (error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

