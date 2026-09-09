import { NextResponse } from "next/server";

import {
  fetchJson,
  mapLimit,
  NEXS_BASE_URL,
  operationalHeaders,
  withAuthRetry,
} from "@/utils/nexs/request";
import { cached, cacheKey, type CacheMeta, type CachedResult } from "@/utils/server/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BARCODE_TTL_MS = 2 * 60_000;
const MAX_INVENTORY_PIDS = 50;
const MAX_DIRECT_BARCODES = 100;
const MAX_HISTORY_PIDS = 20;
const MAX_HISTORY_FANOUT = 300;
const UPSTREAM_PAGE_SIZE = 200;
const MAX_PAGES = 10;
const INVENTORY_CONCURRENCY = 5;
const HISTORY_CONCURRENCY = 8;
const INVENTORY_URL = `${NEXS_BASE_URL}/nexs/api/ims/fetchSlaveBarcodeItemDetails`;
const HISTORY_URL = `${NEXS_BASE_URL}/nexs/api/ims/getHistory`;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

type JsonObject = Record<string, unknown>;
type Cell = string | number | boolean | null;

type BarcodeItem = {
  barcode: string;
  pid: Cell;
  availability: Cell;
  status: Cell;
  operation: Cell;
  location: Cell;
  locationType: Cell;
  condition: Cell;
  legalOwner: Cell;
  facility: Cell;
  updatedAt: Cell;
  updatedBy: Cell;
  createdAt: Cell;
  createdBy: Cell;
  actionId: Cell;
  enabled: Cell;
  barcodeScanRequired: Cell;
  boxBarcode: Cell;
  expiry: Cell;
};

type BarcodeInventory = {
  pid: string;
  items: BarcodeItem[];
  total: number;
  truncated: boolean;
};

type BarcodeHistory = {
  barcode: string;
  current: BarcodeItem | null;
  events: BarcodeItem[];
  total: number;
};

type PidEntry = { pid: string; cutoff: string | null };

class InputError extends Error {}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function primitive(value: unknown): Cell {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function normalizeFacility(value: unknown): string {
  const facility = typeof value === "string" ? value.trim().toUpperCase() : "NXS1";
  if (!/^[A-Z0-9_-]{2,16}$/.test(facility)) throw new InputError("Invalid facility code.");
  return facility;
}

function normalizeCondition(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string") throw new InputError("Condition must be text.");
  const condition = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_ -]{1,23}$/.test(condition)) throw new InputError("Invalid inventory condition.");
  return condition;
}

function normalizePids(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) throw new InputError("pids must be an array.");
  const output: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const pid = typeof candidate === "string" ? candidate.trim() : "";
    if (!/^\d{4,12}$/.test(pid)) throw new InputError(`Invalid product ID: ${pid.slice(0, 16) || "empty"}`);
    if (!seen.has(pid)) {
      seen.add(pid);
      output.push(pid);
    }
  }
  if (!output.length) throw new InputError("Enter at least one product ID.");
  if (output.length > maximum) throw new InputError(`A maximum of ${maximum} product IDs is allowed.`);
  return output;
}

function normalizeBarcodes(value: unknown): string[] {
  if (!Array.isArray(value)) throw new InputError("barcodes must be an array.");
  const output: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const barcode = typeof candidate === "string" ? candidate.trim().toUpperCase() : "";
    if (!/^[A-Z0-9][A-Z0-9._:/-]{2,79}$/.test(barcode)) {
      throw new InputError(`Invalid barcode: ${barcode.slice(0, 20) || "empty"}`);
    }
    if (!seen.has(barcode)) {
      seen.add(barcode);
      output.push(barcode);
    }
  }
  if (!output.length) throw new InputError("Enter at least one barcode.");
  if (output.length > MAX_DIRECT_BARCODES) {
    throw new InputError(`A maximum of ${MAX_DIRECT_BARCODES} barcodes is allowed.`);
  }
  return output;
}

function normalizePidEntries(value: unknown): PidEntry[] {
  if (!Array.isArray(value)) throw new InputError("pidEntries must be an array.");
  const entries: PidEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const object = asObject(candidate);
    const pid = typeof object.pid === "string" ? object.pid.trim() : "";
    if (!/^\d{4,12}$/.test(pid)) throw new InputError(`Invalid product ID: ${pid.slice(0, 16) || "empty"}`);
    let cutoff: string | null = null;
    if (object.cutoff !== null && object.cutoff !== undefined && object.cutoff !== "") {
      if (typeof object.cutoff !== "string" || !Number.isFinite(Date.parse(object.cutoff))) {
        throw new InputError(`Invalid cutoff date for PID ${pid}.`);
      }
      cutoff = new Date(object.cutoff).toISOString();
    }
    const key = `${pid}|${cutoff || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({ pid, cutoff });
    }
  }
  if (!entries.length) throw new InputError("Enter at least one PID and optional cutoff.");
  if (entries.length > MAX_HISTORY_PIDS) {
    throw new InputError(`PID history is limited to ${MAX_HISTORY_PIDS} PIDs per request.`);
  }
  return entries;
}

function mapBarcode(value: unknown, fallbackBarcode = ""): BarcodeItem {
  const source = asObject(value);
  const barcodeValue = primitive(source.barcode);
  return {
    barcode: typeof barcodeValue === "string" || typeof barcodeValue === "number"
      ? String(barcodeValue)
      : fallbackBarcode,
    pid: primitive(source.pid),
    availability: primitive(source.availability),
    status: primitive(source.status),
    operation: primitive(source.operation),
    location: primitive(source.location),
    locationType: primitive(source.locationType),
    condition: primitive(source.condition),
    legalOwner: primitive(source.legalOwner),
    facility: primitive(source.facility),
    updatedAt: primitive(source.updatedAt),
    updatedBy: primitive(source.updatedBy),
    createdAt: primitive(source.createdAt),
    createdBy: primitive(source.createdBy),
    actionId: primitive(source.actionId),
    enabled: primitive(source.enabled),
    barcodeScanRequired: primitive(source.barcodeScanRequired),
    boxBarcode: primitive(source.boxBarcode),
    expiry: primitive(source.expiry),
  };
}

function publicError(error: unknown, label: string): string {
  if (error instanceof Error && error.name === "AbortError") return `${label} timed out.`;
  if (error instanceof Error && error.message.startsWith("NexS authentication")) return error.message;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `${label} failed with HTTP ${status}.` : `${label} is unavailable.`;
}

async function loadInventory(
  request: Request,
  pid: string,
  facility: string,
  condition: string,
  fetchNonDispatchOnly: boolean,
  force: boolean,
): Promise<CachedResult<BarcodeInventory>> {
  const appId = process.env.NEXS_IMS_APP_ID || process.env.NEXS_WMS_APP_ID || "nexs_wms";
  return cached(
    cacheKey("barcode-inventory", { condition, facility, fetchNonDispatchOnly, pid }),
    BARCODE_TTL_MS,
    () => withAuthRetry(request, appId, "all", async (auth) => {
      const items: BarcodeItem[] = [];
      let reportedTotal = 0;
      let page = 0;
      while (page < MAX_PAGES) {
        const url = new URL(INVENTORY_URL);
        url.searchParams.set("page", String(page));
        url.searchParams.set("size", String(UPSTREAM_PAGE_SIZE));
        url.searchParams.set("sortBy", "barcode");
        url.searchParams.set("sortOrder", "DESC");
        url.searchParams.set("totalCountRequired", "true");
        const barcodeItem: JsonObject = { pid, facility, enabled: true };
        if (condition) barcodeItem.condition = condition;
        const payload = await fetchJson<unknown>(url.toString(), {
          method: "POST",
          headers: {
            ...operationalHeaders(facility),
            ...auth,
            Referer: `${NEXS_BASE_URL}/inventory/${encodeURIComponent(pid)}`,
          },
          body: JSON.stringify({ fetchNonDispatchOnly, barcodeItems: [barcodeItem] }),
        });
        const data = asObject(asObject(payload).data);
        const batch = Array.isArray(data.barcodeItems) ? data.barcodeItems.map((item) => mapBarcode(item)) : [];
        const total = Number(data.totalCount);
        if (Number.isFinite(total)) reportedTotal = Math.max(0, Math.trunc(total));
        else if (page === 0) reportedTotal = batch.length;
        items.push(...batch);
        page += 1;
        if (!batch.length || batch.length < UPSTREAM_PAGE_SIZE || items.length >= reportedTotal) break;
      }
      const deduped = [...new Map(items.filter((item) => item.barcode).map((item) => [item.barcode, item])).values()];
      return {
        pid,
        items: deduped,
        total: Math.max(reportedTotal, deduped.length),
        truncated: page >= MAX_PAGES && deduped.length < reportedTotal,
      };
    }),
    force,
  );
}

async function loadHistory(
  request: Request,
  barcode: string,
  facility: string,
  force: boolean,
): Promise<CachedResult<BarcodeHistory>> {
  const appId = process.env.NEXS_IMS_APP_ID || process.env.NEXS_WMS_APP_ID || "nexs_wms";
  return cached(
    cacheKey("barcode-history", { barcode, facility }),
    BARCODE_TTL_MS,
    () => withAuthRetry(request, appId, "all", async (auth) => {
      const payload = await fetchJson<unknown>(HISTORY_URL, {
        method: "POST",
        headers: {
          ...operationalHeaders(facility),
          ...auth,
          Referer: `${NEXS_BASE_URL}/historyPage/${encodeURIComponent(barcode)}`,
        },
        body: JSON.stringify({
          type: "barcode",
          pageRequest: { sortKey: "updatedAt", sortOrder: "DESC" },
          barcode,
        }),
      });
      const data = asObject(asObject(payload).data);
      const search = asObject(data.searchResultResponse);
      const events = Array.isArray(search.results)
        ? search.results.map((event) => mapBarcode(event, barcode))
        : [];
      const currentSource = data.currentStatusSearchResultResponse;
      return {
        barcode,
        current: currentSource ? mapBarcode(currentSource, barcode) : events[0] || null,
        events,
        total: events.length,
      };
    }),
    force,
  );
}

function afterCutoff(event: BarcodeItem, cutoff: string | null): boolean {
  if (!cutoff || typeof event.updatedAt !== "string") return true;
  const eventTime = Date.parse(event.updatedAt);
  return !Number.isFinite(eventTime) || eventTime > Date.parse(cutoff);
}

async function inventoryResponse(request: Request, body: JsonObject, facility: string, force: boolean) {
  const pids = normalizePids(body.pids, MAX_INVENTORY_PIDS);
  const condition = normalizeCondition(body.condition);
  const fetchNonDispatchOnly = body.fetchNonDispatchOnly !== false;
  const results = await mapLimit(pids, INVENTORY_CONCURRENCY, async (pid) => {
    try {
      const loaded = await loadInventory(request, pid, facility, condition, fetchNonDispatchOnly, force);
      return { ...loaded.value, cache: loaded.cache, error: null as string | null };
    } catch (error) {
      return {
        pid,
        items: [] as BarcodeItem[],
        total: 0,
        truncated: false,
        cache: null as CacheMeta | null,
        error: publicError(error, "Barcode inventory lookup"),
      };
    }
  });
  return NextResponse.json({ ok: true, mode: "inventory", facility, condition, fetchNonDispatchOnly, results }, { headers: NO_STORE_HEADERS });
}

async function directHistoryResponse(request: Request, body: JsonObject, facility: string, force: boolean) {
  const barcodes = normalizeBarcodes(body.barcodes);
  const history = await mapLimit(barcodes, HISTORY_CONCURRENCY, async (barcode) => {
    try {
      const loaded = await loadHistory(request, barcode, facility, force);
      return { ...loaded.value, pid: null, cutoff: null, inventory: null, cache: loaded.cache, error: null as string | null };
    } catch (error) {
      return {
        barcode,
        pid: null,
        cutoff: null,
        inventory: null,
        current: null,
        events: [] as BarcodeItem[],
        total: 0,
        cache: null as CacheMeta | null,
        error: publicError(error, "Barcode history lookup"),
      };
    }
  });
  return NextResponse.json({ ok: true, mode: "history", source: "barcode", facility, history, pidErrors: [] }, { headers: NO_STORE_HEADERS });
}

async function pidHistoryResponse(request: Request, body: JsonObject, facility: string, force: boolean) {
  const entries = normalizePidEntries(body.pidEntries);
  const condition = normalizeCondition(body.condition || "GOOD");
  const inventoryLoads = await mapLimit(entries, INVENTORY_CONCURRENCY, async (entry) => {
    try {
      const loaded = await loadInventory(request, entry.pid, facility, condition, true, force);
      return { entry, inventory: loaded.value, error: null as string | null };
    } catch (error) {
      return { entry, inventory: null, error: publicError(error, "PID barcode lookup") };
    }
  });

  const jobs = inventoryLoads.flatMap(({ entry, inventory }) => (inventory?.items || []).map((item) => ({
    pid: entry.pid,
    cutoff: entry.cutoff,
    barcode: item.barcode,
    inventory: item,
  })));
  const limitedJobs = jobs.slice(0, MAX_HISTORY_FANOUT);
  const history = await mapLimit(limitedJobs, HISTORY_CONCURRENCY, async (job) => {
    try {
      const loaded = await loadHistory(request, job.barcode, facility, force);
      const events = loaded.value.events.filter((event) => afterCutoff(event, job.cutoff));
      return {
        ...loaded.value,
        pid: job.pid,
        cutoff: job.cutoff,
        inventory: job.inventory,
        events,
        total: events.length,
        cache: loaded.cache,
        error: null as string | null,
      };
    } catch (error) {
      return {
        barcode: job.barcode,
        pid: job.pid,
        cutoff: job.cutoff,
        inventory: job.inventory,
        current: null,
        events: [] as BarcodeItem[],
        total: 0,
        cache: null as CacheMeta | null,
        error: publicError(error, "Barcode history lookup"),
      };
    }
  });
  const pidErrors = inventoryLoads
    .filter((item) => item.error)
    .map((item) => ({ pid: item.entry.pid, error: item.error }));
  return NextResponse.json({
    ok: true,
    mode: "history",
    source: "pid",
    facility,
    history,
    pidErrors,
    fanout: { requested: jobs.length, returned: limitedJobs.length, truncated: jobs.length > MAX_HISTORY_FANOUT },
  }, { headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  try {
    const body = asObject(await request.json().catch(() => {
      throw new InputError("Request body must be valid JSON.");
    }));
    const facility = normalizeFacility(body.facility);
    const force = body.force === true;
    if (body.mode === "inventory") return inventoryResponse(request, body, facility, force);
    if (body.mode === "history") {
      if (body.source === "pid") return pidHistoryResponse(request, body, facility, force);
      if (body.source === "barcode") return directHistoryResponse(request, body, facility, force);
      throw new InputError("History source must be barcode or pid.");
    }
    throw new InputError("Mode must be inventory or history.");
  } catch (error) {
    if (error instanceof InputError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400, headers: NO_STORE_HEADERS });
    }
    console.error("[barcode-intelligence] request failed", error);
    return NextResponse.json({ ok: false, error: "Unable to process barcode lookups." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
