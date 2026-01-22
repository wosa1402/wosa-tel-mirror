import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

function findRepoRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function loadEnv(): void {
  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot) {
    dotenv.config({ path: path.join(repoRoot, ".env") });
  }
  dotenv.config();
}

loadEnv();

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("Missing env DATABASE_URL");
  return url;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return fallback;
}

function isSupabasePooler(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.port === "6543") return true;
    if (parsed.hostname.includes(".pooler.supabase.com")) return true;
  } catch {
    // ignore
  }
  return false;
}

const globalForDb = globalThis as unknown as {
  __tgBackSql?: postgres.Sql;
  __tgBackDb?: ReturnType<typeof drizzle>;
  __tgBackListenSql?: postgres.Sql;
};

const databaseUrl = requireDatabaseUrl();
const pooler = isSupabasePooler(databaseUrl);

const max = parsePositiveIntEnv("DB_POOL_MAX", pooler ? 2 : 5);
const connectTimeout = parsePositiveIntEnv("DB_CONNECT_TIMEOUT", 30);
const idleTimeout = parsePositiveIntEnv("DB_IDLE_TIMEOUT", 60);
const prepare = parseBooleanEnv("DB_PREPARE", !pooler);

const sql =
  globalForDb.__tgBackSql ??
  postgres(databaseUrl, {
    max,
    connect_timeout: connectTimeout,
    idle_timeout: idleTimeout,
    prepare,
  });
globalForDb.__tgBackSql = sql;

export const db = globalForDb.__tgBackDb ?? drizzle(sql, { schema });
globalForDb.__tgBackDb = db;

export type Db = typeof db;

function getListenDatabaseUrl(): string {
  const direct = process.env.DATABASE_URL_LISTEN?.trim();
  if (direct) return direct;
  const fallback = process.env.DATABASE_URL_DIRECT?.trim();
  if (fallback) return fallback;
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.port === "6543") {
      const derived = new URL(parsed.toString());
      derived.port = "5432";
      return derived.toString();
    }
  } catch {
    // ignore
  }
  return databaseUrl;
}

const listenDatabaseUrl = getListenDatabaseUrl();
const listenPooler = isSupabasePooler(listenDatabaseUrl);
const listenMax = parsePositiveIntEnv("DB_LISTEN_POOL_MAX", listenPooler ? 2 : 5);
const listenPrepare = parseBooleanEnv("DB_LISTEN_PREPARE", !listenPooler);

export const sqlClient = sql;
export const listenSqlClient =
  globalForDb.__tgBackListenSql ??
  postgres(listenDatabaseUrl, {
    max: listenMax,
    connect_timeout: connectTimeout,
    idle_timeout: idleTimeout,
    prepare: listenPrepare,
  });
globalForDb.__tgBackListenSql = listenSqlClient;
