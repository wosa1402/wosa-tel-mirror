import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { loadEnv } from "@/lib/env";
import { requireApiAuth } from "@/lib/api-auth";

loadEnv();

function findRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    if (fsSync.existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function getTrimmedString(value: string | null): string {
  if (!value) return "";
  return value.trim();
}

function parseIntSafe(value: string): number | null {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

function resolveLogFilePath(raw: string): string {
  if (path.isAbsolute(raw)) return raw;
  const repoRoot = findRepoRoot(process.cwd()) ?? process.cwd();
  return path.resolve(repoRoot, raw);
}

async function readTailLines(
  filePath: string,
  limit: number,
): Promise<{ lines: string[]; truncated: boolean; sizeBytes: number; updatedAt: string | null }> {
  const stat = await fs.stat(filePath);
  const sizeBytes = stat.size;
  const updatedAt = stat.mtime ? stat.mtime.toISOString() : null;
  if (sizeBytes <= 0) return { lines: [], truncated: false, sizeBytes, updatedAt };

  const safeLimit = Math.min(2000, Math.max(1, Math.trunc(limit)));
  const maxBytes = Math.min(4 * 1024 * 1024, Math.max(256 * 1024, safeLimit * 512));
  const start = Math.max(0, sizeBytes - maxBytes);
  const length = sizeBytes - start;

  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    const chunk = buf.subarray(0, bytesRead).toString("utf8");
    const normalized = start > 0 ? chunk.slice(chunk.indexOf("\n") + 1) : chunk;
    const rawLines = normalized.split(/\r?\n/g);
    while (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();

    const truncated = rawLines.length > safeLimit || start > 0;
    const lines = rawLines.slice(-safeLimit);
    return { lines, truncated, sizeBytes, updatedAt };
  } finally {
    await handle.close();
  }
}

export async function GET(request: NextRequest) {
  try {
    const authError = await requireApiAuth(request);
    if (authError) return authError;

    const rawPath = process.env.MIRROR_LOG_FILE?.trim() ?? "";
    if (!rawPath) {
      return NextResponse.json({ enabled: false, error: "未配置 MIRROR_LOG_FILE" });
    }

    const url = new URL(request.url);
    const limitRaw = getTrimmedString(url.searchParams.get("limit"));
    const limitParsed = limitRaw ? parseIntSafe(limitRaw) : null;
    const limit = Math.min(2000, Math.max(1, Math.trunc(limitParsed ?? 200)));

    const filePath = resolveLogFilePath(rawPath);
    const { lines, truncated, sizeBytes, updatedAt } = await readTailLines(filePath, limit);

    return NextResponse.json({
      enabled: true,
      configuredPath: rawPath,
      filePath,
      limit,
      truncated,
      sizeBytes,
      updatedAt,
      lines,
    });
  } catch (error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
