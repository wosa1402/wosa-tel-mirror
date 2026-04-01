import { NextResponse } from "next/server";
import { toPublicErrorMessage } from "@/lib/api-error";

export function toInternalServerErrorResponse(error: unknown, fallbackMessage: string): NextResponse {
  console.error(error);
  return NextResponse.json({ error: toPublicErrorMessage(error, fallbackMessage) }, { status: 500 });
}

