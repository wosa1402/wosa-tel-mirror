import { NextRequest } from "next/server";
import net from "node:net";

type Bucket = {
  count: number;
  resetAt: number;
};

type GlobalRateLimitState = {
  __tgBackRateLimitBuckets?: Map<string, Bucket>;
  __tgBackRateLimitCleanupStarted?: boolean;
};

const globalState = globalThis as unknown as GlobalRateLimitState;

const buckets = globalState.__tgBackRateLimitBuckets ?? new Map<string, Bucket>();
globalState.__tgBackRateLimitBuckets = buckets;

function cleanupExpiredBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

if (!globalState.__tgBackRateLimitCleanupStarted) {
  globalState.__tgBackRateLimitCleanupStarted = true;
  const timer = setInterval(cleanupExpiredBuckets, 60_000);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    timer.unref();
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y" || v === "on";
}

function extractIp(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("[") && trimmed.includes("]")) {
    const inside = trimmed.slice(1, trimmed.indexOf("]"));
    return net.isIP(inside) ? inside : null;
  }

  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(trimmed);
  if (ipv4WithPort?.[1] && net.isIP(ipv4WithPort[1])) return ipv4WithPort[1];

  return net.isIP(trimmed) ? trimmed : null;
}

export function getClientIp(request: NextRequest): string {
  const trustProxy = isTruthyEnv(process.env.TG_BACK_TRUST_PROXY);
  if (!trustProxy) return "unknown";

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor.split(",").map((p) => p.trim());
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const ip = parts[i] ? extractIp(parts[i]) : null;
      if (ip) return ip;
    }
  }

  const realIp = request.headers.get("x-real-ip");
  const ip = realIp ? extractIp(realIp) : null;
  if (ip) return ip;

  return "unknown";
}

export function checkRateLimit(key: string, opts: { windowMs: number; max: number }): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const windowMs = Math.max(250, Math.trunc(opts.windowMs));
  const max = Math.max(1, Math.trunc(opts.max));

  const current = buckets.get(key);
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
  buckets.set(key, bucket);

  if (bucket.count >= max) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { allowed: false, retryAfterSec };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}
