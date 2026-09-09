import { getNexsToken, invalidateNexsToken, rejectNexsToken } from "@/utils/nexs/auth";

const NEXS_ORIGIN = "https://app.nexs.lenskart.com";

type QueueTicket = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type LimiterState = { active: number; queue: QueueTicket[]; max: number };

declare global {
  var __nexsUpstreamLimiter: LimiterState | undefined;
}

const configuredLimit = Number(process.env.NEXS_MAX_CONCURRENCY || 12);
const configuredQueueLimit = Number(process.env.NEXS_MAX_QUEUE || 200);
const limiter: LimiterState = globalThis.__nexsUpstreamLimiter ?? {
  active: 0,
  queue: [],
  max: Number.isFinite(configuredLimit) ? Math.max(2, Math.min(40, configuredLimit)) : 12,
};
globalThis.__nexsUpstreamLimiter = limiter;
const MAX_QUEUE = Number.isFinite(configuredQueueLimit)
  ? Math.max(20, Math.min(2_000, Math.trunc(configuredQueueLimit)))
  : 200;
const configuredResponseMegabytes = Number(process.env.NEXS_MAX_RESPONSE_MB || 32);
const MAX_RESPONSE_BYTES = (Number.isFinite(configuredResponseMegabytes)
  ? Math.max(1, Math.min(256, configuredResponseMegabytes))
  : 32) * 1_024 * 1_024;

export type AuthStyle = "cookie" | "jwt-header" | "bearer" | "all";

export async function nexsAuthHeaders(
  request: Request,
  appId: string,
  style: AuthStyle = "all",
  force = false,
): Promise<Record<string, string>> {
  // Deliberately never forward a browser JWT. All callers share cache entries,
  // so a single server identity keeps both permissions and cached data scoped
  // consistently across users.
  void request;
  const token = await getNexsToken(appId, force);
  if (!token) throw new Error("NexS server authentication is not configured or the login failed.");

  const headers: Record<string, string> = {};
  if (style === "cookie" || style === "all") headers.Cookie = `jwt-token=${token}`;
  if (style === "jwt-header" || style === "all") headers["jwt-token"] = token;
  if (style === "bearer" || style === "all") headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function operationalHeaders(facility?: string, workstation?: string): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "date-time": new Date().toISOString().replace("T", " ").slice(0, 19),
    "facility-code": facility || process.env.NEXS_FACILITY || "NXS1",
    "workstation-id": workstation || process.env.NEXS_WORKSTATION || "QC01",
    "source-domain": NEXS_ORIGIN,
  };
}

async function upstreamPermit(waitMs = 30_000): Promise<() => void> {
  const releaseFactory = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = limiter.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(releaseFactory());
      } else {
        limiter.active = Math.max(0, limiter.active - 1);
      }
    };
  };

  if (limiter.active < limiter.max) {
    limiter.active += 1;
    return releaseFactory();
  }

  if (limiter.queue.length >= MAX_QUEUE) {
    throw new Error("The NexS request queue is full. Please retry shortly.");
  }

  return new Promise<() => void>((resolve, reject) => {
    const ticket = { resolve, reject, timer: undefined as unknown as ReturnType<typeof setTimeout> };
    ticket.timer = setTimeout(() => {
      const index = limiter.queue.indexOf(ticket);
      if (index >= 0) limiter.queue.splice(index, 1);
      reject(new Error("The NexS request queue is busy. Please retry shortly."));
    }, waitMs);
    limiter.queue.push(ticket);
  });
}

async function responseText(response: Response): Promise<string> {
  const reported = Number(response.headers.get("content-length"));
  if (Number.isFinite(reported) && reported > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("The NexS response exceeded the server safety limit.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("The NexS response exceeded the server safety limit.");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const release = await upstreamPermit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    const response = await fetch(url, { ...init, signal, cache: "no-store" });
    const text = await responseText(response);
    let payload: unknown = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    if (!response.ok) {
      const upstreamDetail = typeof payload === "string"
        ? payload.slice(0, 240)
        : JSON.stringify(payload).slice(0, 240);
      const error = new Error(`NexS HTTP ${response.status}`);
      Object.assign(error, { status: response.status, upstreamDetail });
      throw error;
    }
    return payload as T;
  } finally {
    clearTimeout(timer);
    release();
  }
}

export async function withAuthRetry<T>(
  request: Request,
  appId: string,
  style: AuthStyle,
  run: (auth: Record<string, string>) => Promise<T>,
): Promise<T> {
  const first = await nexsAuthHeaders(request, appId, style);
  try {
    return await run(first);
  } catch (error) {
    if ((error as { status?: number }).status !== 401) throw error;
    invalidateNexsToken(appId, tokenFromAuthHeaders(first));
    const fresh = await nexsAuthHeaders(request, appId, style);
    try {
      return await run(fresh);
    } catch (retryError) {
      if ((retryError as { status?: number }).status === 401) {
        rejectNexsToken(appId, tokenFromAuthHeaders(fresh));
      }
      throw retryError;
    }
  }
}

function tokenFromAuthHeaders(headers: Record<string, string>): string | null {
  if (headers["jwt-token"]) return headers["jwt-token"];
  if (headers.Authorization?.startsWith("Bearer ")) return headers.Authorization.slice(7);
  return headers.Cookie?.match(/(?:^|;\s*)jwt-token=([^;]+)/)?.[1] || null;
}

export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return output;
}

export const NEXS_BASE_URL = NEXS_ORIGIN;
