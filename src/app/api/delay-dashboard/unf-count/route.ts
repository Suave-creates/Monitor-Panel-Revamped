import { NextResponse } from "next/server";

import {
  NEXS_BASE_URL,
  fetchJson,
  operationalHeaders,
  withAuthRetry,
} from "@/utils/nexs/request";
import { cacheKey, cached } from "@/utils/server/cache";
import { pickingPriorityFor, type DateRange, type International, type Priority } from "@/lib/server/delay-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live Unfulfillable order count for the Delay Dashboard's global
// Fulfillable / UNF switch. Reads NexS's own monitor-panel summary grid
// (the same homePage call behind NexS's "UNFULFILLABLE ORDERS <n>" header,
// also used by the KPI Dashboard) — one cheap call instead of paging every
// UNF stage's detail rows just to count them.

const HOME_URL = `${NEXS_BASE_URL}/nexs/analytics/monitoring/v3/homePage?version=v3`;
const ANALYTICS_APP_ID = process.env.NEXS_ANALYTICS_APP_ID || "nexs-analytics";
const UNF_SECTION = "UNFULFILLABLE_ORDERS";
// The categories the dashboard tracks — NexS's "Others" bucket is excluded.
const TRACKED_TAGS = ["FR1", "FR2", "FR0", "BULK"];
const TTL_MS = 5 * 60_000;
const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" } as const;

type Facility = "NXS1" | "NXS2";
type UnknownRecord = Record<string, unknown>;

class InputError extends Error {}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}
function asRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter((item): item is UnknownRecord => asRecord(item) !== null) : [];
}
function parseFacility(value: unknown): Facility {
  if (value === "NXS1" || value === "NXS2") return value;
  throw new InputError("Facility must be NXS1 or NXS2.");
}
function parsePriority(value: unknown): Priority {
  return value === "p1" || value === "p2" ? value : "all";
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

/** Sums the UNF section's TOTAL column per FR tag. The grid lives either
 *  directly under `data` or under a severity layer (`standard`, …). */
function parseUnf(payload: unknown) {
  const top = asRecord(payload) ?? {};
  const root = asRecord(top.data) ?? top;
  let rows = asRecordArray(root[UNF_SECTION]);
  if (!rows.length) rows = asRecordArray(asRecord(root.standard)?.[UNF_SECTION]);

  const byFrTag: Record<string, number> = {};
  for (const row of rows) {
    const tag = String(row["Fr Tag"] ?? row.frTag ?? "").trim().toUpperCase();
    if (!tag || tag === "TOTAL") continue;
    const total = Number(row.TOTAL);
    if (Number.isFinite(total)) byFrTag[tag] = (byFrTag[tag] ?? 0) + total;
  }
  const total = TRACKED_TAGS.reduce((sum, tag) => sum + (byFrTag[tag] ?? 0), 0);
  return { found: rows.length > 0, total, byFrTag };
}

async function fetchUnf(request: Request, facility: Facility, priority: Priority, international: International, dateRange: DateRange | undefined) {
  const binaryFilter: UnknownRecord = { isJit: false };
  if (international === "intl") binaryFilter.isInternationalOrder = true;
  else if (international === "nonintl") binaryFilter.isInternationalOrder = false;
  const body = {
    monitorPanelFilters: {
      binaryFilter,
      singleSelectFilters: { errorType: "" },
      monitorPanelRangeFilters: {
        ageingSinceCreated: { startValue: 0, endValue: "-1" },
        ageingSinceLastUpdate: { startValue: 0, endValue: "-1" },
        date: dateRange || { startValue: "", endValue: "" },
      },
      multiSelectFilters: {
        pickingPriority: pickingPriorityFor(priority),
        qcStatus: [],
        itemType: [],
        orderChannel: [],
      },
    },
  };
  const payload = await withAuthRetry(request, ANALYTICS_APP_ID, "all", (auth) => fetchJson<unknown>(HOME_URL, {
    method: "POST",
    headers: { ...operationalHeaders(facility), ...auth },
    body: JSON.stringify(body),
  }, 25_000));
  return { fetchedAt: new Date().toISOString(), ...parseUnf(payload) };
}

function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  try {
    const input = asRecord(await request.json());
    if (!input) throw new InputError("Expected a JSON object.");
    const facility = parseFacility(input.facility);
    const priority = parsePriority(input.priority);
    const international = parseInternational(input.international);
    const dateRange = parseDateRange(input.dateRange);
    const force = input.force === true;

    const key = cacheKey("delay-dashboard-unf-count", { facility, priority, international, dateRange });
    const result = await cached(key, TTL_MS, () => fetchUnf(request, facility, priority, international, dateRange), force);
    return jsonResponse({ ok: true, data: result.value, cache: result.cache });
  } catch (error) {
    if (error instanceof InputError) return jsonResponse({ ok: false, error: error.message }, 400);
    console.error("[delay-dashboard/unf-count] Request failed.", error);
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 401 || status === 403) return jsonResponse({ ok: false, error: "NexS authentication is unavailable or has expired." }, 401);
    return jsonResponse({ ok: false, error: "UNF count is temporarily unavailable." }, 502);
  }
}
