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
  aggregateStats,
  buildMonitoringBody,
  DWELL,
  frameProductId,
  groupOrders,
  groupQcfOrders,
  groupTaggedOrders,
  health,
  hoursSince,
  MEI_DWELL,
  mergeQcfOrders,
  normFrame,
  PACKING_DISPATCH_CATEGORY,
  PACKING_DISPATCH_SUBSTAGES,
  QCFAIL_CATEGORY,
  QCFAIL_SUBSTAGES,
  STAGES,
  stageStats,
  WAREHOUSE_CATEGORY,
  WAREHOUSE_SUBSTAGES,
  type DateRange,
  type GroupedOrder,
  type International,
  type OrderItem,
  type RawRow,
  type StageKey,
  type TaggedOrder,
} from "@/lib/server/delay-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DETAILS_URL = `${NEXS_BASE_URL}/nexs/analytics/monitoring/v3/details?version=v3`;
const FITTING_DETAILS_URL = `${NEXS_BASE_URL}/nexs/wms/api/v1/fittingDetails/`;
const CATALOG_URL = `${NEXS_BASE_URL}/nexs/api/catalog/v1/product/additionalDetails?pid=`;
const ANALYTICS_APP_ID = process.env.NEXS_ANALYTICS_APP_ID || "nexs-analytics";
const WMS_APP_ID = process.env.NEXS_WMS_APP_ID || "nexs_wms";
const CATALOG_APP_ID = process.env.NEXS_CATALOG_APP_ID || process.env.NEXS_SEARCH_APP_ID || process.env.NEXS_APP_ID || "nexs_search";

const PAGE_SIZE = 1_000;
// Safety ceiling, not a realistic expectation — see fetchMonitoringRows:
// pages are driven by the response's own `total` field, not a fixed cap
// that silently truncates high-volume stages (confirmed on Bulk (CL/CLS)
// stages with 100,000+ raw rows; the old fixed cap here stopped at 50,000).
const MAX_PAGES = 300;
const REPORT_TTL_MS = 20_000;
const QCFAIL_TTL_MS = 30_000;
const WAREHOUSE_TTL_MS = 30_000;
const PACKING_DISPATCH_TTL_MS = 20_000;
const FRAME_TTL_MS = 6 * 60 * 60_000;
const ITEM_DETAILS_TTL_MS = 10 * 60_000;
const FRAME_CONCURRENCY = 16;
const DETAIL_CONCURRENCY = 24;
const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" } as const;

type Facility = "NXS1" | "NXS2";
type Jit = "all" | "jit" | "nonjit";
type FrFilter = "all" | "FR1" | "FR2";
type FrameFilter = "all" | "fullrim" | "halfrim" | "rimless";
type Action = "report" | "qcfail" | "warehouse" | "packingDispatch";

class InputError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseAction(value: unknown): Action {
  if (value === "report" || value === "qcfail" || value === "warehouse" || value === "packingDispatch") return value;
  throw new InputError("action must be report, qcfail, warehouse, or packingDispatch.");
}
function parseFacility(value: unknown): Facility {
  if (value === "NXS1" || value === "NXS2") return value;
  throw new InputError("Facility must be NXS1 or NXS2.");
}
function parseJit(value: unknown): Jit {
  if (value === "jit" || value === "nonjit" || value === "all") return value;
  throw new InputError("jit must be all, jit, or nonjit.");
}
function parseFrFilter(value: unknown): FrFilter {
  if (value === "FR1" || value === "FR2" || value === "all") return value;
  throw new InputError("frFilter must be all, FR1, or FR2.");
}
function parseFrameFilter(value: unknown): FrameFilter {
  if (value === "fullrim" || value === "halfrim" || value === "rimless" || value === "all") return value;
  throw new InputError("frameFilter must be all, fullrim, halfrim, or rimless.");
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

async function fetchMonitoringRows(
  request: Request,
  apiStatus: string,
  category: string,
  frTag: string,
  nddOnly: boolean,
  dateRange: DateRange | undefined,
  international: International,
  facility: Facility,
  qcFailFilter = false,
): Promise<RawRow[]> {
  return withAuthRetry(request, ANALYTICS_APP_ID, "all", async (auth) => {
    const fetchPage = (page: number) => fetchJson<unknown>(DETAILS_URL, {
      method: "POST",
      headers: { ...operationalHeaders(facility), ...auth },
      body: JSON.stringify(buildMonitoringBody(apiStatus, {
        page, category, frTag, nddOnly, dateRange, pageSize: PAGE_SIZE, international, qcFailFilter,
      })),
    }, 30_000).then(extractPage);

    const first = await fetchPage(0);
    const rows: RawRow[] = [...first.rows];
    const totalPages = Math.min(MAX_PAGES, Math.ceil(first.total / PAGE_SIZE));
    if (totalPages > 1) {
      // mapLimit, not Promise.all — a high-volume stage can need 200+
      // pages, and firing all of them at once (even though fetchJson's
      // global upstream semaphore still caps actual HTTP concurrency)
      // floods the semaphore's own admission queue (NEXS_MAX_QUEUE) once
      // several status/frTag pulls are doing this at the same time, which
      // throws "queue is full" instead of ever running. A small per-pull
      // concurrency keeps queued-at-once requests bounded.
      const rest = await mapLimit(
        Array.from({ length: totalPages - 1 }, (_, i) => i + 1),
        5,
        (page) => fetchPage(page),
      );
      rest.forEach((p) => rows.push(...p.rows));
    }
    return rows;
  });
}

function applyJitFilter<T extends { jitFlag: boolean }>(orders: T[], jit: Jit): T[] {
  if (jit === "jit") return orders.filter((o) => o.jitFlag);
  if (jit === "nonjit") return orders.filter((o) => !o.jitFlag);
  return orders;
}

/* ── Report: QC + Fitting + MEI in one response, with optional frame filter ── */
async function fetchStageOrders(
  request: Request, stageKey: StageKey, frFilter: FrFilter, nddOnly: boolean,
  dateRange: DateRange | undefined, international: International, facility: Facility,
): Promise<GroupedOrder[]> {
  const cfg = STAGES[stageKey];
  const frTags = frFilter === "all" ? ["FR1", "FR2"] : [frFilter];
  const perTag = await Promise.all(frTags.map((frTag) =>
    fetchMonitoringRows(request, cfg.apiStatus, cfg.category, frTag, nddOnly, dateRange, international, facility)));
  return groupOrders(perTag.flat(), stageKey);
}

async function fetchFrameType(request: Request, facility: Facility, productId: string): Promise<string> {
  return withAuthRetry(request, CATALOG_APP_ID, "all", async (auth) => {
    const payload = await fetchJson<unknown>(CATALOG_URL + encodeURIComponent(productId), {
      method: "GET",
      headers: { ...operationalHeaders(facility), ...auth },
    }, 15_000);
    const top = asRecord(payload) ?? {};
    const data = asRecord(top.data) ?? {};
    const details = asRecord(data.productDetailsResponse) ?? {};
    return typeof details.frameType === "string" ? details.frameType : "";
  });
}

async function ensureFrameTypes(request: Request, facility: Facility, orders: GroupedOrder[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const pids = [...new Set(orders.map(frameProductId).filter((pid): pid is string => !!pid))];
  await mapLimit(pids, FRAME_CONCURRENCY, async (pid) => {
    const { value } = await cached(cacheKey("delay-dashboard-frame-type", { pid }), FRAME_TTL_MS, () =>
      fetchFrameType(request, facility, pid));
    result.set(pid, value);
  });
  return result;
}

function applyFrameFilter(orders: GroupedOrder[], frameFilter: FrameFilter, frameTypes: Map<string, string>): GroupedOrder[] {
  if (frameFilter === "all") return orders;
  return orders.filter((o) => {
    const pid = frameProductId(o);
    return pid ? normFrame(frameTypes.get(pid)) === frameFilter : false;
  });
}

async function fetchReport(
  request: Request, facility: Facility, nddOnly: boolean, jit: Jit, frFilter: FrFilter,
  frameFilter: FrameFilter, international: International, dateRange: DateRange | undefined,
) {
  const stageKeys = Object.keys(STAGES) as StageKey[];
  const rawByStage = await Promise.all(stageKeys.map((stageKey) =>
    fetchStageOrders(request, stageKey, frFilter, nddOnly, dateRange, international, facility)));

  const frameTypes = frameFilter === "all"
    ? new Map<string, string>()
    : await ensureFrameTypes(request, facility, rawByStage.flat());

  const stages: Record<string, { stats: ReturnType<typeof stageStats> & { health: ReturnType<typeof health> }; orders: GroupedOrder[] }> = {};
  stageKeys.forEach((stageKey, index) => {
    let orders = applyJitFilter(rawByStage[index], jit);
    orders = applyFrameFilter(orders, frameFilter, frameTypes);
    const dwt = stageKey === "MEI" && !nddOnly ? MEI_DWELL : DWELL;
    const stats = stageStats(orders, stageKey, dwt);
    stages[stageKey] = { stats: { ...stats, health: health(stats) }, orders };
  });

  return { fetchedAt: new Date().toISOString(), stages };
}

/* ── Warehouse / Packing & Dispatch (generic sub-stage fetch) ────────── */
async function fetchSubStageOrders(
  request: Request, sub: { key: string; api: string; label: string }, category: string,
  frFilter: FrFilter, nddOnly: boolean, dateRange: DateRange | undefined, international: International, facility: Facility,
): Promise<TaggedOrder[]> {
  const frTags = frFilter === "all" ? ["FR1", "FR2"] : [frFilter];
  const perTag = await Promise.all(frTags.map((frTag) =>
    fetchMonitoringRows(request, sub.api, category, frTag, nddOnly, dateRange, international, facility)));
  return groupTaggedOrders(perTag.flat(), sub.key, sub.label);
}

async function fetchPipelineSection(
  request: Request, facility: Facility, substages: { key: string; api: string; label: string }[], category: string,
  nddOnly: boolean, jit: Jit, frFilter: FrFilter, international: International, dateRange: DateRange | undefined,
) {
  const bySubStage = await Promise.all(substages.map((sub) =>
    fetchSubStageOrders(request, sub, category, frFilter, nddOnly, dateRange, international, facility)));
  let orders = bySubStage.flat();
  orders = applyJitFilter(orders, jit);
  const stats = aggregateStats(orders, DWELL);
  return { fetchedAt: new Date().toISOString(), stats: { ...stats, health: health(stats) }, orders };
}

/* ── QC-Fail rework pipeline ──────────────────────────────────────── */
async function fetchQcfailSub(
  request: Request, sub: { key: string; api: string; qcFailFilter?: boolean }, frFilter: FrFilter,
  nddOnly: boolean, dateRange: DateRange | undefined, international: International, facility: Facility,
) {
  const frTags = frFilter === "all" ? ["FR1", "FR2"] : [frFilter];
  const perTag = await Promise.all(frTags.map((frTag) =>
    fetchMonitoringRows(request, sub.api, QCFAIL_CATEGORY, frTag, nddOnly, dateRange, international, facility, sub.qcFailFilter || false)));
  return groupQcfOrders(perTag.flat(), sub.key);
}

function extractItemDetails(payload: unknown): OrderItem[] {
  const top = asRecord(payload) ?? {};
  const data = asRecord(top.data) ?? {};
  const items = Array.isArray(data.item_details) ? data.item_details as Record<string, unknown>[] : [];
  return items.map((it) => {
    const updatedAt = it.updated_at;
    return {
      itemType: String(it.type ?? ""),
      status: String(it.status ?? ""),
      barcode: it.barcode != null ? String(it.barcode) : "",
      productId: it.product_id != null ? String(it.product_id) : "",
      lensType: "",
      lastUpdate: hoursSince(updatedAt),
      updatedAt: typeof updatedAt === "string" ? updatedAt : undefined,
    };
  });
}

async function fetchItemDetails(request: Request, facility: Facility, shipmentId: string): Promise<OrderItem[]> {
  return withAuthRetry(request, WMS_APP_ID, "all", async (auth) => {
    const payload = await fetchJson<unknown>(FITTING_DETAILS_URL + encodeURIComponent(shipmentId), {
      method: "GET",
      headers: { ...operationalHeaders(facility), ...auth },
    }, 15_000);
    return extractItemDetails(payload);
  });
}

async function fetchQcfail(
  request: Request, facility: Facility, nddOnly: boolean, jit: Jit, frFilter: FrFilter,
  international: International, dateRange: DateRange | undefined,
) {
  const dataBySubKey: Record<string, TaggedOrder[]> = {};
  await Promise.all(QCFAIL_SUBSTAGES.map(async (sub) => {
    dataBySubKey[sub.key] = await fetchQcfailSub(request, sub, frFilter, nddOnly, dateRange, international, facility);
  }));

  const packageIds = new Set<string>();
  Object.values(dataBySubKey).forEach((orders) => orders.forEach((o) => {
    if (o.shippingPackageId) packageIds.add(o.shippingPackageId);
  }));

  const detailsByPackageId = new Map<string, OrderItem[]>();
  await mapLimit([...packageIds], DETAIL_CONCURRENCY, async (id) => {
    try {
      const { value } = await cached(
        cacheKey("delay-dashboard-item-details", { facility, id }),
        ITEM_DETAILS_TTL_MS,
        () => fetchItemDetails(request, facility, id),
      );
      detailsByPackageId.set(id, value);
    } catch {
      // leave uncached — merge falls back to the monitoring-API items.
    }
  });

  let orders = mergeQcfOrders(dataBySubKey, detailsByPackageId);
  orders = applyJitFilter(orders, jit);
  return { fetchedAt: new Date().toISOString(), orders };
}

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function responseError(error: unknown) {
  const upstreamStatus = (error as { status?: unknown } | null)?.status;
  if (error instanceof InputError) {
    return jsonResponse({ ok: false, error: error.message }, 400);
  }
  console.error("[delay-dashboard] Request failed.", error);
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return jsonResponse({ ok: false, error: "NexS authentication is unavailable or has expired." }, 401);
  }
  return jsonResponse({ ok: false, error: "Delay dashboard data is temporarily unavailable. Please retry." }, 502);
}

export async function POST(request: Request) {
  try {
    const input = asRecord(await request.json());
    if (!input) throw new InputError("Expected a JSON object.");
    const action = parseAction(input.action);
    const facility = parseFacility(input.facility);
    const nddOnly = input.nddOnly !== false;
    const jit = parseJit(input.jit);
    const frFilter = parseFrFilter(input.frFilter);
    const international = parseInternational(input.international);
    const dateRange = parseDateRange(input.dateRange);
    const force = input.force === true;

    if (action === "report") {
      const frameFilter = parseFrameFilter(input.frameFilter);
      const key = cacheKey("delay-dashboard-report", { facility, nddOnly, jit, frFilter, frameFilter, international, dateRange });
      const result = await cached(key, REPORT_TTL_MS, () =>
        fetchReport(request, facility, nddOnly, jit, frFilter, frameFilter, international, dateRange), force);
      return jsonResponse({ ok: true, data: result.value, cache: result.cache });
    }

    if (action === "qcfail") {
      const key = cacheKey("delay-dashboard-qcfail", { facility, nddOnly, jit, frFilter, international, dateRange });
      const result = await cached(key, QCFAIL_TTL_MS, () =>
        fetchQcfail(request, facility, nddOnly, jit, frFilter, international, dateRange), force);
      return jsonResponse({ ok: true, data: result.value, cache: result.cache });
    }

    if (action === "warehouse") {
      const key = cacheKey("delay-dashboard-warehouse", { facility, nddOnly, jit, frFilter, international, dateRange });
      const result = await cached(key, WAREHOUSE_TTL_MS, () =>
        fetchPipelineSection(request, facility, WAREHOUSE_SUBSTAGES, WAREHOUSE_CATEGORY, nddOnly, jit, frFilter, international, dateRange), force);
      return jsonResponse({ ok: true, data: result.value, cache: result.cache });
    }

    // action === "packingDispatch"
    const key = cacheKey("delay-dashboard-packing-dispatch", { facility, nddOnly, jit, frFilter, international, dateRange });
    const result = await cached(key, PACKING_DISPATCH_TTL_MS, () =>
      fetchPipelineSection(request, facility, PACKING_DISPATCH_SUBSTAGES, PACKING_DISPATCH_CATEGORY, nddOnly, jit, frFilter, international, dateRange), force);
    return jsonResponse({ ok: true, data: result.value, cache: result.cache });
  } catch (error) {
    return responseError(error);
  }
}
