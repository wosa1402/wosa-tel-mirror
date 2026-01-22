import { NextRequest, NextResponse } from "next/server";
import { getAccessStatus } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  try {
    const { enabled, authed } = await getAccessStatus(request);
    return NextResponse.json({ enabled, authed });
  } catch (error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

