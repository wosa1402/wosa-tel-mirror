import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";

loadEnv();

export const ACCESS_COOKIE_NAME = "tg_back_access";

const TOKEN_VERSION = "v1";
const MAX_TOKEN_AGE_SEC = 60 * 60 * 24 * 14; // 14 days

function requireEncryptionSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET?.trim();
  if (!secret) throw new Error("Missing env ENCRYPTION_SECRET");
  return secret;
}

function normalizeSettingString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

export async function getAccessPassword(): Promise<string> {
  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, "access_password"))
    .limit(1);

  return normalizeSettingString(row?.value).trim();
}

export function isAccessPasswordEnabled(accessPassword: string): boolean {
  return accessPassword.trim().length > 0;
}

function sign(message: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function createAccessToken(accessPassword: string): string {
  const secret = requireEncryptionSecret();
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("base64url");
  const unsigned = `${TOKEN_VERSION}:${ts}:${nonce}`;
  const sig = sign(`${unsigned}:${accessPassword}`, secret);
  return `${unsigned}:${sig}`;
}

export function verifyAccessToken(token: string, accessPassword: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;

  const parts = trimmed.split(":");
  if (parts.length !== 4) return false;
  const [version, tsRaw, nonce, sig] = parts;
  if (version !== TOKEN_VERSION) return false;

  const ts = Number.parseInt(tsRaw ?? "", 10);
  if (!Number.isFinite(ts)) return false;
  if (!nonce) return false;
  if (!sig) return false;

  const now = Math.floor(Date.now() / 1000);
  if (ts > now + 60) return false;
  if (now - ts > MAX_TOKEN_AGE_SEC) return false;

  const secret = requireEncryptionSecret();
  const unsigned = `${version}:${ts}:${nonce}`;
  const expected = sign(`${unsigned}:${accessPassword}`, secret);
  return safeEqual(expected, sig);
}

export async function getAccessStatus(request: NextRequest): Promise<{ enabled: boolean; authed: boolean }> {
  const accessPassword = await getAccessPassword();
  const enabled = isAccessPasswordEnabled(accessPassword);
  if (!enabled) return { enabled: false, authed: true };

  const token = request.cookies.get(ACCESS_COOKIE_NAME)?.value ?? "";
  const authed = verifyAccessToken(token, accessPassword);
  return { enabled: true, authed };
}

export async function requireApiAuth(request: NextRequest): Promise<NextResponse | null> {
  const { enabled, authed } = await getAccessStatus(request);
  if (!enabled || authed) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function setAccessCookie(response: NextResponse, token: string | null): void {
  if (!token) {
    response.cookies.set(ACCESS_COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return;
  }

  response.cookies.set(ACCESS_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_TOKEN_AGE_SEC,
  });
}

