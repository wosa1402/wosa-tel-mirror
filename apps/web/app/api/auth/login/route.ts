import { NextRequest, NextResponse } from "next/server";
import {
  createAccessToken,
  getAccessPassword,
  isAccessPasswordEnabled,
  setAccessCookie,
  verifyAndMaybeUpgradeAccessPassword,
} from "@/lib/api-auth";
import { toPublicErrorMessage } from "@/lib/api-error";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { getTrimmedString } from "@/lib/utils";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const password = getTrimmedString(body.password);

    const accessPassword = await getAccessPassword();
    const enabled = isAccessPasswordEnabled(accessPassword);

    if (!enabled) {
      return NextResponse.json({ enabled: false, authed: true });
    }

    const ip = getClientIp(request);
    const loginLimiter = checkRateLimit(`auth:login:${ip}`, { windowMs: 5 * 60 * 1000, max: 10 });
    if (!loginLimiter.allowed) {
      const res = NextResponse.json({ error: "Too many login attempts, please try again later" }, { status: 429 });
      res.headers.set("Retry-After", String(loginLimiter.retryAfterSec));
      return res;
    }

    if (!password) {
      return NextResponse.json({ error: "password is required" }, { status: 400 });
    }

    const storedForToken = await verifyAndMaybeUpgradeAccessPassword(password, accessPassword);
    if (!storedForToken) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    const token = createAccessToken(storedForToken);
    const res = NextResponse.json({ enabled: true, authed: true });
    setAccessCookie(res, token);
    return res;
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: toPublicErrorMessage(error, "登录失败") }, { status: 500 });
  }
}
