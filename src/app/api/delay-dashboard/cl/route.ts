import { NextResponse } from "next/server";

import {
  NEXS_BASE_URL,
  fetchJson,
  mapLimit,
  operationalHeaders,
  withAuthRetry,
} from "@/utils/nexs/request";
import { cacheKey, cached } from "@/utils/server/cache";
import {
  applyJitFilter,
  buildMonitoringBody,
  DEPT_ORDER,
  DEPTS,
  groupOrders,
  type DateRange,
  type DeptKey,
  type GroupedOrder,
  type International,
  type RawRow,
  type StageKey,
} from "@/lib/server/cl-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The CL Report view lives inside the Delay Dashboard module, beside
// Dispatch Report — this route is a sibling under /api/delay-dashboard/,
// same pattern as pid-masters's and dispatch's own sibling routes.

const DETAILS_URL = `${NEXS_BASE_URL}/nexs/analytics/monitoring/v3/details?version=v3`;
const ANALYTICS_APP_ID = process.env.NEXS_ANALYTICS_APP_ID || "nexs-analytics";

const PAGE_SIZE = 500;
// Safety ceiling, not a realistic expectation — Bulk (CL/CLS) stages have
// been observed with 100,000+ raw item rows (NexS's own admin panel shows
// "Showing 35/119084" for Bulk : Pending Picking at one snapshot). The old
// fixed cap of 60 pages (30,000 rows) silently truncated far short of that,
// which is why Bulk's counts were wrong. Pages are now driven by the
// response's own `total` field (see fetchDeptStage) and fetched in
// parallel, so this ceiling only guards against a corrupted/absurd total.
const MAX_PAGES = 600;
const REPORT_TTL_MS = 15 * 60_000;
const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" } as const;

type Facility = "NXS1" | "NXS2";
type Jit = "all" | "jit" | "nonjit";

class InputError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseFacility(value: unknown): Facility {
  if (value === "NXS1" || value === "NXS2") return value;
  throw new InputError("Facility must be NXS1 or NXS2.");
}
function parseJit(value: unknown): Jit {
  if (value === "jit" || value === "nonjit" || value === "all") return value;
  throw new InputError("jit must be all, jit, or nonjit.");
}
function parseInternational(value: unknown): International {
  return value === "intl" || value === "nonintl" ? value : "all";
}
function parseDateRange(value: unknown): DateRange | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const startValue = typeof record.startValue === "string" ? record.startValue : "";
  const endValue = typeof record.endValue === "string" ? record.endValue : "";
  if (!startValue && !endValue) return undefined;
  return { startValue, endValue };
}

/** The response carries its own authoritative `total` (e.g.
 *  `{"data":{"count":35,"total":4361,"data":[...]}}`) — that's what page
 *  count must be driven by, not "did this page come back full". */
function extractPage(payload: unknown): { rows: RawRow[]; total: number } {
  const top = asRecord(payload) ?? {};
  const box = asRecord(top.data) ?? top;
  const rows = Array.isArray(box.data) ? box.data as RawRow[] : [];
  const total = Number(box.total);
  return { rows, total: Number.isFinite(total) ? total : rows.length };
}

async function fetchDeptStage(
  request: Request, facility: Facility, deptKey: DeptKey, stageKey: StageKey,
  nddOnly: boolean, dateRange: DateRange | undefined, international: International,
): Promise<GroupedOrder[]> {
  return withAuthRetry(request, ANALYTICS_APP_ID, "all", async (auth) => {
    const fetchPage = (page: number) => fetchJson<unknown>(DETAILS_URL, {
      method: "POST",
      headers: { ...operationalHeaders(facility), ...auth },
      body: JSON.stringify(buildMonitoringBody(deptKey, stageKey, { page, nddOnly, dateRange, pageSize: PAGE_SIZE, international })),
    }, 30_000).then(extractPage);

    const first = await fetchPage(0);
    const rows: RawRow[] = [...first.rows];
    const totalPages = Math.min(MAX_PAGES, Math.ceil(first.total / PAGE_SIZE));
    if (totalPages > 1) {
      // mapLimit, not Promise.all — a high-volume stage can need 200+
      // pages, and firing all of them at once (even though fetchJson's
      // global upstream semaphore still caps actual HTTP concurrency)
      // floods the semaphore's own admission queue (NEXS_MAX_QUEUE) once
      // several (category, stage) jobs are doing this at the same time,
      // which throws "queue is full" instead of ever running. A small
      // per-job concurrency keeps queued-at-once requests bounded.
      const rest = await mapLimit(
        Array.from({ length: totalPages - 1 }, (_, i) => i + 1),
        5,
        (page) => fetchPage(page),
      );
      rest.forEach((p) => rows.push(...p.rows));
    }
    return groupOrders(rows, DEPTS[deptKey].itemType);
  });
}

async function fetchReport(
  request: Request, facility: Facility, nddOnly: boolean, jit: Jit,
  international: International, dateRange: DateRange | undefined,
) {
  const jobs: { dk: DeptKey; sk: StageKey }[] = [];
  DEPT_ORDER.forEach((dk) => DEPTS[dk].stages.forEach((sk) => jobs.push({ dk, sk })));

  const results = await mapLimit(jobs, 8, ({ dk, sk }) =>
    fetchDeptStage(request, facility, dk, sk, nddOnly, dateRange, international));

  const categories: Record<string, Record<string, { orders: GroupedOrder[]; total: number }>> = {};
  jobs.forEach(({ dk, sk }, index) => {
    const orders = applyJitFilter(results[index], jit);
    categories[dk] = categories[dk] || {};
    categories[dk][sk] = { orders, total: orders.length };
  });

  return { fetchedAt: new Date().toISOString(), categories };
}

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function responseError(error: unknown) {
  const upstreamStatus = (error as { status?: unknown } | null)?.status;
  if (error instanceof InputError) {
    return jsonResponse({ ok: false, error: error.message }, 400);
  }
  console.error("[delay-dashboard/cl] Request failed.", error);
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return jsonResponse({ ok: false, error: "NexS authentication is unavailable or has expired." }, 401);
  }
  return jsonResponse({ ok: false, error: "CL report data is temporarily unavailable. Please retry." }, 502);
}

export async function POST(request: Request) {
  try {
    const input = asRecord(await request.json());
    if (!input) throw new InputError("Expected a JSON object.");
    const facility = parseFacility(input.facility);
    const nddOnly = input.nddOnly === true;
    const jit = parseJit(input.jit);
    const international = parseInternational(input.international);
    const dateRange = parseDateRange(input.dateRange);
    const force = input.force === true;

    const key = cacheKey("delay-dashboard-cl", { facility, nddOnly, jit, international, dateRange });
    const result = await cached(key, REPORT_TTL_MS, () =>
      fetchReport(request, facility, nddOnly, jit, international, dateRange), force);
    return jsonResponse({ ok: true, data: result.value, cache: result.cache });
  } catch (error) {
    return responseError(error);
  }
}
