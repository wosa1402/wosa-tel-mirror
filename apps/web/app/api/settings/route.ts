import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";
import { requireApiAuth, setAccessCookie } from "@/lib/api-auth";

loadEnv();

type MirrorMode = (typeof schema.mirrorModeEnum.enumValues)[number];

type SettingsKey = keyof typeof schema.defaultSettings;

const editableKeys = Object.keys(schema.defaultSettings).filter((k) => k !== "telegram_session") as SettingsKey[];

function getTrimmedString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
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

function toStringOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function isMirrorMode(value: unknown): value is MirrorMode {
  return value === "forward" || value === "copy";
}

function buildMergedSettings(rows: Array<{ key: string; value: unknown }>) {
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const merged: Partial<Record<SettingsKey, unknown>> = {};
  for (const key of editableKeys) {
    const defaultValue = schema.defaultSettings[key];
    const raw = map.get(key as string);

    if (key === "access_password") {
      merged[key] = "";
      continue;
    }

    if (raw == null) {
      merged[key] = defaultValue;
      continue;
    }

    if (typeof defaultValue === "boolean") {
      merged[key] = toBooleanOrNull(raw) ?? defaultValue;
      continue;
    }

    if (typeof defaultValue === "number") {
      merged[key] = toNumberOrNull(raw) ?? defaultValue;
      continue;
    }

    merged[key] = toStringOrNull(raw) ?? defaultValue;
  }

  const telegramRaw = map.get("telegram_session");
  const telegramSessionValue = typeof telegramRaw === "string" ? telegramRaw : telegramRaw == null ? "" : String(telegramRaw);
  const telegramSessionSet = telegramSessionValue.trim().length > 0;

  const accessRaw = map.get("access_password");
  const accessPasswordValue = typeof accessRaw === "string" ? accessRaw : accessRaw == null ? "" : String(accessRaw);
  const accessPasswordSet = accessPasswordValue.trim().length > 0;

  return { merged: merged as Record<SettingsKey, unknown>, telegramSessionSet, accessPasswordSet };
}

export async function GET(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;
    const rows = await db.select().from(schema.settings);
    const { merged, telegramSessionSet, accessPasswordSet } = buildMergedSettings(rows);

    return NextResponse.json({
      settings: merged,
      telegramSessionSet,
      accessPasswordSet,
    });
  } catch (error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const body = await request.json().catch(() => ({}));
    const updates = (body?.updates ?? body?.values ?? null) as unknown;

    if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
      return NextResponse.json({ error: "updates must be an object" }, { status: 400 });
    }

    const entries = Object.entries(updates as Record<string, unknown>);
    if (!entries.length) {
      return NextResponse.json({ error: "no updates provided" }, { status: 400 });
    }

    let changedAccessPassword: string | null = null;

    for (const [rawKey, rawValue] of entries) {
      const key = getTrimmedString(rawKey);
      if (!key) return NextResponse.json({ error: "invalid key" }, { status: 400 });
      if (!editableKeys.includes(key as SettingsKey)) {
        return NextResponse.json({ error: `unsupported setting key: ${key}` }, { status: 400 });
      }

      const defaultValue = schema.defaultSettings[key as SettingsKey];
      let valueToStore: unknown = rawValue;

      if (key === "default_mirror_mode") {
        if (!isMirrorMode(rawValue)) {
          return NextResponse.json({ error: "default_mirror_mode must be forward|copy" }, { status: 400 });
        }
        valueToStore = rawValue;
      } else if (typeof defaultValue === "boolean") {
        const parsed = toBooleanOrNull(rawValue);
        if (parsed == null) return NextResponse.json({ error: `${key} must be boolean` }, { status: 400 });
        valueToStore = parsed;
      } else if (typeof defaultValue === "number") {
        const parsed = toNumberOrNull(rawValue);
        if (parsed == null) return NextResponse.json({ error: `${key} must be number` }, { status: 400 });
        valueToStore = parsed;
      } else {
        valueToStore = getTrimmedString(toStringOrNull(rawValue));
      }

      await db
        .insert(schema.settings)
        .values({ key, value: valueToStore })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: valueToStore },
        });

      if (key === "access_password") {
        changedAccessPassword = typeof valueToStore === "string" ? valueToStore.trim() : String(valueToStore ?? "").trim();
      }
    }

    const rows = await db.select().from(schema.settings);
    const { merged, telegramSessionSet, accessPasswordSet } = buildMergedSettings(rows);

    const requireReauth = changedAccessPassword != null && changedAccessPassword.trim().length > 0;

    const res = NextResponse.json({
      success: true,
      settings: merged,
      telegramSessionSet,
      accessPasswordSet,
      requireReauth,
    });

    if (changedAccessPassword != null) {
      setAccessCookie(res, null);
    }

    return res;
  } catch (error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
