import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function configured(): boolean {
  return Boolean(process.env.APP_BASIC_AUTH_USER && process.env.APP_BASIC_AUTH_PASSWORD);
}

function equal(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function credentials(request: NextRequest): { user: string; password: string } | null {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();

  if (!configured()) {
    if (process.env.NODE_ENV !== "production") return NextResponse.next();
    return new NextResponse("Application access control is not configured.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const supplied = credentials(request);
  const valid = supplied
    && equal(supplied.user, process.env.APP_BASIC_AUTH_USER || "")
    && equal(supplied.password, process.env.APP_BASIC_AUTH_PASSWORD || "");
  if (valid) return NextResponse.next();

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="NexS Operations Console", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
