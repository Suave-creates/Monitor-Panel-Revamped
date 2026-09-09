import { NextResponse } from "next/server";
import { nexsAuthConfigured } from "@/utils/nexs/auth";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const readinessRequested = new URL(request.url).searchParams.get("ready") === "1";
  const ready = nexsAuthConfigured()
    && Boolean(process.env.APP_BASIC_AUTH_USER && process.env.APP_BASIC_AUTH_PASSWORD);
  const status = readinessRequested && !ready ? 503 : 200;
  return NextResponse.json(
    {
      status: status === 200 ? "ok" : "not_ready",
      service: "nexs-operations-console",
      timestamp: new Date().toISOString(),
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
