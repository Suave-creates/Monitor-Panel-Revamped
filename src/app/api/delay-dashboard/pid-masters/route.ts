import { NextResponse } from "next/server";

import { getPidMasters, resetPidMasters, savePidMastersSide } from "@/lib/server/pid-masters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" } as const;
const MAX_PIDS = 200_000;

class InputError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function responseError(error: unknown) {
  if (error instanceof InputError) return jsonResponse({ ok: false, error: error.message }, 400);
  console.error("[delay-dashboard/pid-masters] Request failed.", error);
  return jsonResponse({ ok: false, error: "PID master data is temporarily unavailable. Please retry." }, 502);
}

export async function GET() {
  try {
    const record = await getPidMasters();
    return jsonResponse({ ok: true, data: record });
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = asRecord(await request.json());
    if (!input) throw new InputError("Expected a JSON object.");
    const action = input.action;

    if (action === "reset") {
      const record = await resetPidMasters();
      return jsonResponse({ ok: true, data: record });
    }

    if (action === "upload") {
      const side = input.side;
      if (side !== "cyl" && side !== "noncyl") throw new InputError("side must be cyl or noncyl.");
      if (!Array.isArray(input.pids)) throw new InputError("pids must be an array.");
      if (input.pids.length > MAX_PIDS) throw new InputError(`A maximum of ${MAX_PIDS.toLocaleString("en-IN")} PIDs is allowed per upload.`);
      const pids = input.pids.map((p) => String(p));
      const source = typeof input.source === "string" ? input.source : undefined;
      const record = await savePidMastersSide(side, pids, source);
      return jsonResponse({ ok: true, data: record });
    }

    throw new InputError("action must be upload or reset.");
  } catch (error) {
    return responseError(error);
  }
}
