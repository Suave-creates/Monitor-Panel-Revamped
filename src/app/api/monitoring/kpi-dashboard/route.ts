import { NextResponse } from "next/server";
import {
  NEXS_BASE_URL,
  fetchJson,
  operationalHeaders,
  withAuthRetry,
} from "@/utils/nexs/request";
import { cacheKey, cached } from "@/utils/server/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Facility = "NXS1" | "NXS2";
type OrderMode = "njit" | "jit";
type GaugeKey = "d1" | "d2" | "ndd";
type UnknownRecord = Record<string, unknown>;

type InfocornerNumbers = {
  dates: UnknownRecord;
  regular: { D_1: number | null; D_2: number | null; TODAY: number | null };
  jit: { D_1: number | null; D_2: number | null; TODAY: number | null };
};

type StageCount = { stage: string; count: number; percentOfDay: number | null };

type GaugeResult = {
  key: GaugeKey;
  label: string;
  sublabel: string;
  day: string;
  mode: OrderMode;
  target: number;
  denominator: number | null;
  open: number;
  readyToShip: number;
  remaining: number;
  completion: number | null;
  ordersToTarget: number | null;
  stages: StageCount[];
  reportAsOn: string | null;
  frTag: string;
  frFound: boolean;
};

const GRID_URL = `${NEXS_BASE_URL}/nexs/analytics/monitoring/v3/homePage?version=v3`;
const DETAILS_URL = `${NEXS_BASE_URL}/nexs/analytics/monitoring/v3/details?version=v3`;
const ANALYTICS_APP_ID = process.env.NEXS_ANALYTICS_APP_ID || "nexs-analytics";
// D1/D2 gauges scope to FR1+FR2 (summed); NDD scopes to every FR tag (null = all).
const GAUGE_FRS: string[] = ["FR1", "FR2"];
const SECTION = "FULFILLABLE_ORDERS";
const DASHBOARD_TTL_MS = 15 * 60_000;
const DETAILS_TTL_MS = 15 * 60_000;
const INFOCORNER_TTL_MS = 60 * 60_000;
const PAGE_SIZE = 1_000;
const MAX_DETAIL_PAGES = 50;
const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" } as const;

// Only server-controlled, per-facility URLs are reachable. Request data can
// select a facility, never an arbitrary host.
const INFOCORNER_URLS: Record<Facility, string> = {
  NXS1: process.env.INFOCORNER_NXS1_URL || "http://192.168.27.132:3069/api/infocorner/numbers",
  NXS2: process.env.INFOCORNER_NXS2_URL || "http://192.168.27.170:3069/api/infocorner/numbers",
};

const NXS2_FILTERS: UnknownRecord = {
  isLensOnlyOrder: false,
  isTrueLastPiece: false,
  isMarketPlaceOrder: false,
  isInternationalOrder: false,
};

class InputError extends Error {}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function asRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter((item): item is UnknownRecord => asRecord(item) !== null) : [];
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseFacility(value: unknown): Facility {
  if (value === "NXS1" || value === "NXS2") return value;
  throw new InputError("Facility must be NXS1 or NXS2.");
}

function parseMode(value: unknown): OrderMode {
  if (value === "njit" || value === "jit") return value;
  throw new InputError("Mode must be njit or jit.");
}

function parseGaugeKey(value: unknown): GaugeKey {
  if (value === "d1" || value === "d2" || value === "ndd") return value;
  throw new InputError("Unknown gauge.");
}

function indiaDay(daysAgo: number): string {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function expectedDay(key: GaugeKey): string {
  return indiaDay(key === "d1" ? 1 : key === "d2" ? 2 : 0);
}

function monitorBody(facility: Facility, mode: OrderMode, day: string, priorityOne: boolean): UnknownRecord {
  return {
    monitorPanelFilters: {
      binaryFilter: {
        isJit: mode === "jit",
        ...(facility === "NXS2" ? NXS2_FILTERS : {}),
      },
      singleSelectFilters: { errorType: "" },
      monitorPanelRangeFilters: {
        ageingSinceCreated: { startValue: 0, endValue: "-1" },
        ageingSinceLastUpdate: { startValue: 0, endValue: "-1" },
        date: { startValue: `${day} 00:00:00`, endValue: `${day} 23:59:59` },
      },
      multiSelectFilters: {
        pickingPriority: priorityOne ? [1] : [],
        qcStatus: [],
        itemType: [],
        orderChannel: [],
      },
    },
  };
}

function payloadRoot(payload: unknown): UnknownRecord {
  const top = asRecord(payload) ?? {};
  return asRecord(top.data) ?? top;
}

function reportTimestamp(payload: unknown): string | null {
  const top = asRecord(payload);
  const root = payloadRoot(payload);
  const value = root.reportAsOn ?? root.REPORT_AS_ON ?? top?.reportAsOn;
  return typeof value === "string" && value ? value : null;
}

function rowsForSeverity(root: UnknownRecord, severity: string): UnknownRecord[] {
  const layer = asRecord(root[severity]);
  if (layer) return asRecordArray(layer[SECTION]);
  return severity === "standard" ? asRecordArray(root[SECTION]) : [];
}

// frs = null sums every FR tag in the response (NDD); an array sums only those
// tags (D1/D2 -> FR1 + FR2). Matches the reference dashboard's GAUGE_FRS / allFr scoping.
function aggregateGrid(root: UnknownRecord, severities: string[], frs: string[] | null) {
  const stages = new Map<string, number>();
  const tagsSeen = new Set<string>();
  let open = 0;
  let readyToShip = 0;

  for (const severity of severities) {
    for (const row of rowsForSeverity(root, severity)) {
      const tag = String(row["Fr Tag"] ?? row.frTag ?? "").trim();
      if (!tag || tag.toUpperCase() === "TOTAL") continue;
      tagsSeen.add(tag);
      if (frs && !frs.includes(tag)) continue;
      open += finiteNumber(row.TOTAL) ?? 0;
      for (const [stage, rawCount] of Object.entries(row)) {
        if (stage === "Fr Tag" || stage === "frTag" || stage === "TOTAL") continue;
        const count = finiteNumber(rawCount) ?? 0;
        if (count <= 0) continue;
        stages.set(stage, (stages.get(stage) ?? 0) + count);
        if (/ready\s*to\s*ship/i.test(stage)) readyToShip += count;
      }
    }
  }
  const frFound = frs ? frs.some((tag) => tagsSeen.has(tag)) : tagsSeen.size > 0;
  return { open, readyToShip, stages, frFound };
}

function parseGrid(payload: unknown, frs: string[] | null) {
  const root = payloadRoot(payload);
  const standard = aggregateGrid(root, ["standard"], frs);
  const selected = standard.open > 0 || standard.stages.size > 0
    ? standard
    : aggregateGrid(root, ["current", "critical", "severe"], frs);
  return { ...selected, reportAsOn: reportTimestamp(payload) };
}

function parseInfocorner(payload: unknown, facility: Facility): InfocornerNumbers {
  const root = payloadRoot(payload);
  const rows = asRecordArray(root.rows);
  const dates = asRecord(root.dates) ?? {};
  const todayKey = indiaDay(0).replace(/-/g, "_");

  const rowFor = (type: string) => rows.find((row) =>
    String(row.facility_code ?? "").toUpperCase() === facility
    && String(row.order_item_type ?? "").toUpperCase() === type,
  );
  const read = (row: UnknownRecord | undefined, keys: unknown[]): number | null => {
    if (!row) return null;
    for (const key of keys) {
      if (typeof key !== "string" || !key) continue;
      const value = finiteNumber(row[key]);
      if (value !== null) return value;
    }
    return null;
  };
  const columns = (type: string) => {
    const row = rowFor(type);
    return {
      D_1: read(row, ["D_1", dates.day_minus_1]),
      D_2: read(row, ["D_2", dates.day_minus_2]),
      TODAY: read(row, ["TODAY", "today", "TODAY_ORDERS", dates.day_minus_0, dates.today, todayKey]),
    };
  };

  return { dates, regular: columns("REGULAR"), jit: columns("JIT") };
}

async function loadInfocorner(facility: Facility) {
  const key = cacheKey("monitoring-kpi-dashboard-infocorner", { facility });
  return cached(key, INFOCORNER_TTL_MS, async () => {
    const preferred = INFOCORNER_URLS[facility];
    const fallback = INFOCORNER_URLS[facility === "NXS1" ? "NXS2" : "NXS1"];
    let lastError: unknown = null;
    for (const url of [preferred, fallback]) {
      try {
        const payload = await fetchJson<unknown>(url, { method: "GET", redirect: "follow" }, 12_000);
        const parsed = parseInfocorner(payload, facility);
        if (parsed.regular.D_1 !== null || parsed.jit.D_1 !== null || parsed.regular.TODAY !== null) {
          return parsed;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) console.error(`[kpi-dashboard] Infocorner request failed for ${facility}.`, lastError);
    throw new Error(`Infocorner denominator is temporarily unavailable for ${facility}.`);
  });
}

type GaugeSpec = {
  key: GaugeKey;
  label: string;
  sublabel: string;
  day: string;
  mode: OrderMode;
  target: number;
  priorityOne: boolean;
  denominatorColumn: "D_1" | "D_2" | "TODAY";
  frs: string[] | null; // null = every FR tag summed (NDD)
};

function gaugeSpecs(mode: OrderMode, includeNdd: boolean): GaugeSpec[] {
  const specs: GaugeSpec[] = [
    { key: "d1", label: "D1", sublabel: "Yesterday", day: indiaDay(1), mode, target: 95, priorityOne: false, denominatorColumn: "D_1", frs: GAUGE_FRS },
    { key: "d2", label: "D2", sublabel: "Day before", day: indiaDay(2), mode, target: 99.5, priorityOne: false, denominatorColumn: "D_2", frs: GAUGE_FRS },
  ];
  if (includeNdd) {
    specs.push({ key: "ndd", label: "NDD", sublabel: "Today · priority 1", day: indiaDay(0), mode: "njit", target: 99, priorityOne: true, denominatorColumn: "TODAY", frs: null });
  }
  return specs;
}

function buildGauge(spec: GaugeSpec, payload: unknown, info: InfocornerNumbers | null): GaugeResult {
  const parsed = parseGrid(payload, spec.frs);
  const denominatorTable = spec.mode === "jit" ? info?.jit : info?.regular;
  const rawDenominator = denominatorTable?.[spec.denominatorColumn] ?? null;
  const denominator = rawDenominator !== null && rawDenominator > 0 ? rawDenominator : null;
  const remaining = Math.max(0, parsed.open - parsed.readyToShip);
  const completion = denominator === null || !parsed.frFound
    ? null
    : Math.max(0, Math.min(100, (1 - remaining / denominator) * 100));
  const completed = denominator === null || !parsed.frFound ? null : denominator - remaining;
  const ordersToTarget = denominator === null || completed === null
    ? null
    : Math.max(0, Math.ceil((spec.target / 100) * denominator - completed));
  const stages = [...parsed.stages.entries()]
    .filter(([stage]) => !/ready\s*to\s*ship/i.test(stage))
    .map(([stage, count]) => ({
      stage,
      count,
      percentOfDay: denominator === null ? null : (count / denominator) * 100,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    key: spec.key,
    label: spec.label,
    sublabel: spec.sublabel,
    day: spec.day,
    mode: spec.mode,
    target: spec.target,
    denominator,
    open: parsed.open,
    readyToShip: parsed.readyToShip,
    remaining,
    completion,
    ordersToTarget,
    stages,
    reportAsOn: parsed.reportAsOn,
    frTag: spec.frs ? spec.frs.join("+") : "ALL FR",
    frFound: parsed.frFound,
  };
}

async function fetchDashboard(request: Request, facility: Facility, mode: OrderMode, includeNdd: boolean) {
  const specs = gaugeSpecs(mode, includeNdd);
  // Manual dashboard refreshes bypass only the short analytics cache. The
  // internal infocorner denominator remains protected by its six-hour TTL.
  const infoPromise = loadInfocorner(facility)
    .then((result) => ({ value: result.value, cache: result.cache, error: null as string | null }))
    .catch((error: unknown) => ({ value: null, cache: null, error: errorMessage(error) }));

  const payloads = await withAuthRetry(request, ANALYTICS_APP_ID, "all", (auth) =>
    Promise.all(specs.map((spec) => fetchJson<unknown>(GRID_URL, {
      method: "POST",
      headers: { ...operationalHeaders(facility), ...auth },
      body: JSON.stringify(monitorBody(facility, spec.mode, spec.day, spec.priorityOne)),
    }, 25_000))),
  );
  const infoResult = await infoPromise;

  return {
    facility,
    mode,
    generatedAt: new Date().toISOString(),
    gauges: specs.map((spec, index) => buildGauge(spec, payloads[index], infoResult.value)),
    infocorner: {
      available: infoResult.value !== null,
      error: infoResult.error,
      dates: infoResult.value?.dates ?? {},
      cache: infoResult.cache,
    },
  };
}

function extractDetailPage(payload: unknown): { rows: UnknownRecord[]; total: number | null } {
  const top = asRecord(payload) ?? {};
  const first = top.data;
  if (Array.isArray(first)) return { rows: asRecordArray(first), total: finiteNumber(top.total) };
  const box = asRecord(first) ?? top;
  const rows = asRecordArray(box.data).length
    ? asRecordArray(box.data)
    : asRecordArray(box.results);
  return { rows, total: finiteNumber(box.total ?? top.total) };
}

// D1/D2 dump FR1 and FR2 separately and merge (the details API takes one frTag
// per call); NDD dumps with an empty frTag, which returns every FR tag.
function detailFrTags(key: GaugeKey): string[] {
  return key === "ndd" ? [""] : GAUGE_FRS;
}

async function fetchDetails(
  request: Request,
  facility: Facility,
  mode: OrderMode,
  key: GaugeKey,
  day: string,
  stage: string,
) {
  const effectiveMode: OrderMode = key === "ndd" ? "njit" : mode;
  const filters = monitorBody(facility, effectiveMode, day, key === "ndd");
  const filterBox = asRecord(filters.monitorPanelFilters) ?? {};
  const frTags = detailFrTags(key);

  return withAuthRetry(request, ANALYTICS_APP_ID, "all", async (auth) => {
    const rows: UnknownRecord[] = [];
    let truncated = false;
    for (const frTag of frTags) {
      let page = 0;
      while (page < MAX_DETAIL_PAGES) {
        const payload = await fetchJson<unknown>(DETAILS_URL, {
          method: "POST",
          headers: { ...operationalHeaders(facility), ...auth },
          body: JSON.stringify({
            page,
            pageSize: PAGE_SIZE,
            globalSearch: "",
            category: SECTION,
            status: stage,
            frTag,
            version: "v3",
            monitorPanelFilters: filterBox,
          }),
        }, 30_000);
        const current = extractDetailPage(payload);
        rows.push(...current.rows);
        page += 1;
        if (current.rows.length === 0 || current.rows.length < PAGE_SIZE) break;
      }
      if (page >= MAX_DETAIL_PAGES) truncated = true;
    }
    return { rows, total: rows.length, truncated };
  });
}

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

function responseError(error: unknown) {
  const upstreamStatus = (error as { status?: unknown })?.status;
  if (error instanceof InputError || error instanceof SyntaxError) {
    return jsonResponse({ ok: false, error: error instanceof InputError ? error.message : "Malformed JSON payload." }, 400);
  }
  console.error("[kpi-dashboard] Request failed.", error);
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return jsonResponse({ ok: false, error: "NexS authentication is unavailable or has expired." }, 401);
  }
  return jsonResponse({ ok: false, error: "KPI dashboard data is temporarily unavailable. Please retry." }, 502);
}

export async function POST(request: Request) {
  try {
    const input = asRecord(await request.json());
    if (!input) throw new InputError("Expected a JSON object.");
    const action = input.action;
    const facility = parseFacility(input.facility);
    const mode = parseMode(input.mode);
    const force = input.force === true;

    if (action === "dashboard") {
      const includeNdd = input.includeNdd !== false;
      const key = cacheKey("monitoring-kpi-dashboard", { facility, mode, includeNdd });
      const result = await cached(key, DASHBOARD_TTL_MS, () => fetchDashboard(request, facility, mode, includeNdd), force);
      return jsonResponse({ ok: true, data: result.value, cache: result.cache });
    }

    if (action === "details") {
      const gauge = parseGaugeKey(input.gauge);
      const day = typeof input.day === "string" ? input.day : "";
      const stage = typeof input.stage === "string" ? input.stage.trim() : "";
      if (day !== expectedDay(gauge)) throw new InputError("The detail date is outside the active gauge window.");
      if (!stage || stage.length > 160) throw new InputError("A valid stage is required.");
      const key = cacheKey("monitoring-kpi-dashboard-details", { facility, mode, gauge, day, stage });
      const result = await cached(
        key,
        DETAILS_TTL_MS,
        () => fetchDetails(request, facility, mode, gauge, day, stage),
        force,
      );
      return jsonResponse({ ok: true, data: result.value, cache: result.cache });
    }

    throw new InputError("Action must be dashboard or details.");
  } catch (error) {
    return responseError(error);
  }
}
