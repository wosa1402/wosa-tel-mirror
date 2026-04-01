import { NextResponse } from "next/server";
import { setAccessCookie } from "@/lib/api-auth";
import { toInternalServerErrorResponse } from "@/lib/api-response";

export async function POST() {
  try {
    const res = NextResponse.json({ success: true });
    setAccessCookie(res, null);
    return res;
  } catch (error: unknown) {
    return toInternalServerErrorResponse(error, "退出登录失败");
  }
}
