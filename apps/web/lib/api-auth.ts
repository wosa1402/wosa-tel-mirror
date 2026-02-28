import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db, parseSettingValue, schema } from "@tg-back/db";
import { loadEnv } from "@/lib/env";

loadEnv();

export const ACCESS_COOKIE_NAME = "tg_back_access";

const TOKEN_VERSION = "v1";
const MAX_TOKEN_AGE_SEC = 60 * 60 * 24 * 14; // 14 days

const BOOTSTRAP_ACCESS_PASSWORD_ENV = "TG_BACK_BOOTSTRAP_ACCESS_PASSWORD";

const ACCESS_PASSWORD_HASH_PREFIX = "scrypt$";
const ACCESS_PASSWORD_SCRYPT_KEYLEN = 32;
const ACCESS_PASSWORD_SCRYPT_DEFAULT_COST = 16384;
const ACCESS_PASSWORD_SCRYPT_DEFAULT_BLOCK_SIZE = 8;
const ACCESS_PASSWORD_SCRYPT_DEFAULT_PARALLELIZATION = 1;
const ACCESS_PASSWORD_SCRYPT_DEFAULT_MAXMEM = 64 * 1024 * 1024;

function requireEncryptionSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET?.trim();
  if (!secret) throw new Error("Missing env ENCRYPTION_SECRET");
  return secret;
}

export async function getAccessPassword(): Promise<string> {
  const [row] = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, "access_password"))
    .limit(1);

  const parsed = parseSettingValue("access_password", row?.value).trim();
  if (row) return parsed;

  const bootstrapPlaintext = process.env[BOOTSTRAP_ACCESS_PASSWORD_ENV]?.trim() ?? "";
  const shouldAutoGenerate = process.env.NODE_ENV === "production";
  const plaintextToSeed = bootstrapPlaintext || (shouldAutoGenerate ? crypto.randomBytes(16).toString("base64url") : "");
  if (!plaintextToSeed) return parsed;

  try {
    const hashed = await hashAccessPassword(plaintextToSeed);
    const inserted = await db
      .insert(schema.settings)
      .values({ key: "access_password", value: hashed })
      .onConflictDoNothing()
      .returning({ value: schema.settings.value });
    if (!bootstrapPlaintext && shouldAutoGenerate && inserted.length) {
      console.warn(
        `[tg-back] 未检测到 access_password，已自动生成初始访问密码：${plaintextToSeed}（请尽快到 /settings 修改）`,
      );
    }
    const [seeded] = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, "access_password"))
      .limit(1);
    return parseSettingValue("access_password", seeded?.value).trim();
  } catch (error: unknown) {
    console.error(error);
    return parsed;
  }
}

export function isAccessPasswordEnabled(accessPassword: string): boolean {
  return accessPassword.trim().length > 0;
}

function toSafeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  if (n <= 0) return null;
  return n;
}

function isScryptHash(value: string): boolean {
  return value.startsWith(ACCESS_PASSWORD_HASH_PREFIX);
}

function parseScryptHash(value: string): {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  key: Buffer;
} | null {
  if (!isScryptHash(value)) return null;
  const parts = value.split("$");
  if (parts.length !== 6) return null;
  const [, costRaw, blockSizeRaw, parallelizationRaw, saltB64, keyB64] = parts;
  const cost = Number.parseInt(costRaw ?? "", 10);
  const blockSize = Number.parseInt(blockSizeRaw ?? "", 10);
  const parallelization = Number.parseInt(parallelizationRaw ?? "", 10);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  if (!Number.isFinite(blockSize) || blockSize <= 0) return null;
  if (!Number.isFinite(parallelization) || parallelization <= 0) return null;

  try {
    const salt = Buffer.from(saltB64 ?? "", "base64");
    const key = Buffer.from(keyB64 ?? "", "base64");
    if (!salt.length || !key.length) return null;
    return { cost, blockSize, parallelization, salt, key };
  } catch {
    return null;
  }
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey as Buffer);
    });
  });
}

function sha256(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function timingSafeEqualBuffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqualBuffer(sha256(a), sha256(b));
}

export async function hashAccessPassword(plaintext: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const options: crypto.ScryptOptions = {
    cost: ACCESS_PASSWORD_SCRYPT_DEFAULT_COST,
    blockSize: ACCESS_PASSWORD_SCRYPT_DEFAULT_BLOCK_SIZE,
    parallelization: ACCESS_PASSWORD_SCRYPT_DEFAULT_PARALLELIZATION,
    maxmem: ACCESS_PASSWORD_SCRYPT_DEFAULT_MAXMEM,
  };
  const derivedKey = await scryptAsync(plaintext, salt, ACCESS_PASSWORD_SCRYPT_KEYLEN, options);

  const cost = toSafeInt(options.cost) ?? ACCESS_PASSWORD_SCRYPT_DEFAULT_COST;
  const blockSize = toSafeInt(options.blockSize) ?? ACCESS_PASSWORD_SCRYPT_DEFAULT_BLOCK_SIZE;
  const parallelization = toSafeInt(options.parallelization) ?? ACCESS_PASSWORD_SCRYPT_DEFAULT_PARALLELIZATION;

  return [
    "scrypt",
    String(cost),
    String(blockSize),
    String(parallelization),
    salt.toString("base64"),
    derivedKey.toString("base64"),
  ].join("$");
}

async function verifyScryptAccessPassword(plaintext: string, stored: string): Promise<boolean> {
  const parsed = parseScryptHash(stored);
  if (!parsed) return false;
  const options: crypto.ScryptOptions = {
    cost: parsed.cost,
    blockSize: parsed.blockSize,
    parallelization: parsed.parallelization,
    maxmem: ACCESS_PASSWORD_SCRYPT_DEFAULT_MAXMEM,
  };
  try {
    const derivedKey = await scryptAsync(plaintext, parsed.salt, parsed.key.length, options);
    return timingSafeEqualBuffer(derivedKey, parsed.key);
  } catch {
    return false;
  }
}

export async function verifyAndMaybeUpgradeAccessPassword(
  inputPassword: string,
  storedAccessPassword: string,
): Promise<string | null> {
  const stored = storedAccessPassword.trim();
  if (!stored) return null;

  if (isScryptHash(stored)) {
    const ok = await verifyScryptAccessPassword(inputPassword, stored);
    return ok ? stored : null;
  }

  const ok = timingSafeEqualString(inputPassword, stored);
  if (!ok) return null;

  const hashed = await hashAccessPassword(inputPassword);
  await db
    .insert(schema.settings)
    .values({ key: "access_password", value: hashed })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: hashed },
    });

  return hashed;
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
