import { NextRequest, NextResponse } from "next/server";
import { getAccessStatus } from "@/lib/api-auth";
import { toPublicErrorMessage } from "@/lib/api-error";

export async function GET(request: NextRequest) {
  try {
    const { enabled, authed } = await getAccessStatus(request);
    return NextResponse.json({ enabled, authed });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: toPublicErrorMessage(error, "获取状态失败") }, { status: 500 });
  }
}
