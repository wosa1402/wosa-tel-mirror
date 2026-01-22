import { NextRequest, NextResponse } from "next/server";
import { createAccessToken, getAccessPassword, isAccessPasswordEnabled, setAccessCookie } from "@/lib/api-auth";

function getTrimmedString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const password = getTrimmedString(body.password);

    const accessPassword = await getAccessPassword();
    const enabled = isAccessPasswordEnabled(accessPassword);

    if (!enabled) {
      return NextResponse.json({ enabled: false, authed: true });
    }

    if (!password) {
      return NextResponse.json({ error: "password is required" }, { status: 400 });
    }

    if (password !== accessPassword) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    const token = createAccessToken(accessPassword);
    const res = NextResponse.json({ enabled: true, authed: true });
    setAccessCookie(res, token);
    return res;
  } catch (error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

