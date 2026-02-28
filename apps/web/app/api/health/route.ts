import { NextResponse } from "next/server";
import { toPublicErrorMessage } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Basic health check
    return NextResponse.json(
      {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: "unhealthy",
        error: toPublicErrorMessage(error, "Unknown error"),
      },
      { status: 500 }
    );
  }
}
