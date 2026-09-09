import { NextResponse } from "next/server";

import {
  fetchJson,
  mapLimit,
  NEXS_BASE_URL,
  operationalHeaders,
  withAuthRetry,
} from "@/utils/nexs/request";
import { cached, cacheKey, type CacheMeta } from "@/utils/server/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVENTORY_TTL_MS = 2 * 60_000;
const PRODUCT_TTL_MS = 6 * 60 * 60_000;
const MAX_PIDS = 100;
const CONCURRENCY = 6;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

type JsonObject = Record<string, unknown>;
type Cell = string | number | boolean | null;

type InventoryData = {
  totalInventory: Cell;
  grn: Cell;
  allocated: Cell;
  available: Cell;
  reserved: Cell;
  blocked: Cell;
  pendingPutAway: Cell;
};

type ProductData = {
  productName: Cell;
  brand: Cell;
  hsnCode: Cell;
  hsnClassification: Cell;
  frameType: Cell;
  frameMaterial: Cell;
  sku: Cell;
  classification: Cell;
  fastPickingEnabled: Cell;
};

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

function caseInsensitive(object: JsonObject, ...keys: string[]): Cell {
  for (const key of keys) {
    const direct = primitive(object[key]);
    if (direct !== null) return direct;
    const match = Object.keys(object).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (match) {
      const value = primitive(object[match]);
      if (value !== null) return value;
    }
  }
  return null;
}

function normalizeFacility(value: unknown): string {
  const facility = typeof value === "string" ? value.trim().toUpperCase() : "NXS1";
  if (!/^[A-Z0-9_-]{2,16}$/.test(facility)) throw new InputError("Invalid facility code.");
  return facility;
}

function normalizeWorkstation(value: unknown): string {
  const workstation = typeof value === "string" ? value.trim() : "QC01";
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(workstation)) throw new InputError("Invalid workstation ID.");
  return workstation;
}

function normalizePids(value: unknown): string[] {
  if (!Array.isArray(value)) throw new InputError("pids must be an array.");
  const pids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const pid = typeof candidate === "string" ? candidate.trim() : "";
    if (!/^\d{4,12}$/.test(pid)) throw new InputError(`Invalid product ID: ${pid.slice(0, 16) || "empty"}`);
    if (!seen.has(pid)) {
      seen.add(pid);
      pids.push(pid);
    }
  }
  if (!pids.length) throw new InputError("Enter at least one product ID.");
  if (pids.length > MAX_PIDS) throw new InputError(`A maximum of ${MAX_PIDS} product IDs is allowed.`);
  return pids;
}

function inventoryObject(payload: unknown): JsonObject {
  const root = asObject(payload);
  const source = root.data ?? root.result ?? root.response ?? payload;
  if (!Array.isArray(source)) return asObject(source);

  const totals: JsonObject = {};
  const numericKeys = [
    "totalInventory",
    "grnInventory",
    "allocatedInventory",
    "availableInventory",
    "reservedInventory",
    "blockedInventory",
    "pendingPutAwayInventory",
  ];
  for (const entry of source) {
    const object = asObject(entry);
    for (const key of numericKeys) {
      const sourceValue = caseInsensitive(object, key);
      if (sourceValue === null) continue;
      const value = Number(sourceValue);
      if (Number.isFinite(value)) totals[key] = Number(totals[key] || 0) + value;
    }
  }
  return totals;
}

function mapInventory(payload: unknown): InventoryData {
  const source = inventoryObject(payload);
  return {
    totalInventory: caseInsensitive(source, "totalInventory", "total_inventory", "totalQty", "total", "qty"),
    grn: caseInsensitive(source, "grnInventory", "grn", "goodsReceived", "grnQty"),
    allocated: caseInsensitive(source, "allocatedInventory", "allocated", "allocatedQty"),
    available: caseInsensitive(source, "availableInventory", "available", "availableQty"),
    reserved: caseInsensitive(source, "reservedInventory", "reserved", "reservedQty"),
    blocked: caseInsensitive(source, "blockedInventory", "blocked", "blockedQty"),
    pendingPutAway: caseInsensitive(source, "pendingPutAwayInventory", "pendingPutAway", "pending_putaway", "pendingPutaway"),
  };
}

function mapProduct(payload: unknown): ProductData {
  const data = asObject(asObject(payload).data);
  const details = asObject(data.productDetailsResponse);
  return {
    productName: primitive(details.value),
    brand: primitive(details.brand),
    hsnCode: primitive(details.hsnCode),
    hsnClassification: primitive(details.hsnClassification),
    frameType: primitive(details.frameType),
    frameMaterial: primitive(details.frameMaterial),
    sku: primitive(details.sku),
    classification: primitive(details.classification),
    fastPickingEnabled: primitive(data.fastPickingEnabled),
  };
}

function publicError(error: unknown, label: string): string {
  if (error instanceof Error && error.name === "AbortError") return `${label} timed out.`;
  if (error instanceof Error && error.message.startsWith("NexS authentication")) return error.message;
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number"
    ? `${label} failed with HTTP ${status}.`
    : `${label} is unavailable.`;
}

async function fetchInventory(
  request: Request,
  pid: string,
  facility: string,
  workstation: string,
): Promise<InventoryData> {
  const appId = process.env.NEXS_WMS_APP_ID || "nexs_wms";
  const url = `${NEXS_BASE_URL}/nexs/cid/api/v1/warehouseInventory/getConsolidatedInvInfo/${encodeURIComponent(pid)}`;
  return withAuthRetry(request, appId, "all", async (auth) => mapInventory(await fetchJson<unknown>(url, {
    method: "GET",
    headers: {
      ...operationalHeaders(facility, workstation),
      ...auth,
      "x-api-client": "desktop",
      Referer: `${NEXS_BASE_URL}/inventory/${encodeURIComponent(pid)}`,
    },
  })));
}

async function fetchProduct(
  request: Request,
  pid: string,
  facility: string,
  workstation: string,
): Promise<ProductData> {
  const appId = process.env.NEXS_CATALOG_APP_ID || process.env.NEXS_SEARCH_APP_ID || process.env.NEXS_APP_ID || "nexs_search";
  const url = `${NEXS_BASE_URL}/nexs/api/catalog/v1/product/additionalDetails?pid=${encodeURIComponent(pid)}`;
  return withAuthRetry(request, appId, "all", async (auth) => mapProduct(await fetchJson<unknown>(url, {
    method: "GET",
    headers: {
      ...operationalHeaders(facility, workstation),
      ...auth,
      Referer: `${NEXS_BASE_URL}/inventory/${encodeURIComponent(pid)}`,
    },
  })));
}

export async function POST(request: Request) {
  try {
    const body = asObject(await request.json().catch(() => {
      throw new InputError("Request body must be valid JSON.");
    }));
    const pids = normalizePids(body.pids);
    const facility = normalizeFacility(body.facility);
    const workstation = normalizeWorkstation(body.workstation);
    const force = body.force === true;

    const results = await mapLimit(pids, CONCURRENCY, async (pid) => {
      const inventoryPromise = cached(
        cacheKey("inventory", { facility, pid, workstation }),
        INVENTORY_TTL_MS,
        () => fetchInventory(request, pid, facility, workstation),
        force,
      );
      const productPromise = cached(
        cacheKey("product-catalog", { facility, pid, workstation }),
        PRODUCT_TTL_MS,
        () => fetchProduct(request, pid, facility, workstation),
        false,
      );
      const [inventory, product] = await Promise.allSettled([inventoryPromise, productPromise]);

      return {
        pid,
        inventory: inventory.status === "fulfilled" ? inventory.value.value : null,
        product: product.status === "fulfilled" ? product.value.value : null,
        cache: {
          inventory: inventory.status === "fulfilled" ? inventory.value.cache : null as CacheMeta | null,
          product: product.status === "fulfilled" ? product.value.cache : null as CacheMeta | null,
        },
        error: inventory.status === "rejected" ? publicError(inventory.reason, "Inventory lookup") : null,
        catalogError: product.status === "rejected" ? publicError(product.reason, "Product catalog lookup") : null,
      };
    });

    return NextResponse.json({ ok: true, facility, workstation, count: results.length, results }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof InputError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400, headers: NO_STORE_HEADERS });
    }
    console.error("[inventory-fetcher] request failed", error);
    return NextResponse.json({ ok: false, error: "Unable to process inventory lookups." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
