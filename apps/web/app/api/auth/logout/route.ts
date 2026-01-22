import { NextResponse } from "next/server";
import { setAccessCookie } from "@/lib/api-auth";

export async function POST() {
  const res = NextResponse.json({ success: true });
  setAccessCookie(res, null);
  return res;
}
