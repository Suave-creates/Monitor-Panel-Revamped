import { NextResponse } from "next/server";

import {
  fetchJson,
  mapLimit,
  NEXS_BASE_URL,
  operationalHeaders,
  withAuthRetry,
} from "@/utils/nexs/request";
import { cached, cacheKey } from "@/utils/server/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FACILITY = process.env.NEXS_FACILITY || "NXS1";
const CHANNEL = "BULKTOVENDOR";
const TIME_ZONE = "Asia/Kolkata";
const LOOKBACK_DAYS = 7;
const PAGE_SIZE = 500;
const MAX_PAGES = 10;
const DETAIL_CONCURRENCY = 5;
const CATALOG_CONCURRENCY = 5;
const META_CONCURRENCY = 3;
const FULL_CACHE_TTL_MS = 20_000;
const SHIPMENT_DETAIL_CACHE_TTL_MS = 60_000;
const CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const NEXS_TIMEOUT_MS = 20_000;

const APP_IDS = {
  shipments: process.env.NEXS_SCRIPTS_APP_ID || process.env.NEXS_APP_ID || "nexs-analytics",
  wms: process.env.NEXS_WMS_APP_ID || "nexs_wms",
  oms: process.env.NEXS_OMS_APP_ID || process.env.NEXS_SEARCH_APP_ID || "nexs_search",
  catalog: process.env.NEXS_CATALOG_APP_ID || process.env.NEXS_WMS_APP_ID || "nexs_wms",
};

const ENDPOINTS = {
  shipments: "/scripts/api/v1/order/channel/details",
  details: "/nexs/wms/api/v1/order/do/details",
  orders: "/inbound/order-sensei/oms/api/v1/distributorOrder/search",
  catalog: "/nexs/api/catalog/v1/product/additionalDetails",
};

const TERMINAL_STATUSES = new Set([
  "DISPATCHED",
  "DELIVERED",
  "DELIVERY_COMPLETED",
  "CANCELLED",
  "CANCELED",
]);

const DISPATCHED_STATUSES = new Set(["DISPATCHED", "DELIVERED", "DELIVERY_COMPLETED"]);
const FULLY_PICKED_STATUSES = new Set(["AWB_CREATED", ...DISPATCHED_STATUSES]);
const EXCLUDED_CLASSIFICATIONS = new Set(["prescription blank"]);

type JsonRecord = Record<string, unknown>;

type DashboardWarning = {
  code: string;
  message: string;
  affected?: number;
};

type RawShipment = {
  id: string;
  status: string;
  createdAt: string | null;
};

type RawPid = {
  productId: string | null;
  description: string;
  required: number;
  scanned: number;
};

type ShipmentDetail = {
  status: string | null;
  customer: string;
  doNumber: string;
  pids: RawPid[];
  malformedPidLines: number;
};

type DetailedShipment = {
  source: RawShipment;
  detail: ShipmentDetail;
  status: string;
};

type DoMeta = {
  doType: string;
  poNumber: string;
};

type CatalogInfo = {
  classification: string;
  hsnCode: string;
  hsnClassification: string;
};

type PidDetail = {
  productId: string | null;
  description: string;
  classification: string;
  required: number;
  picked: number;
  pending: number;
};

type ShipmentRow = {
  id: string;
  status: string;
  customer: string;
  doNumber: string;
  poNumber: string;
  doType: string;
  required: number;
  picked: number;
  pending: number;
  pidCount: number;
  createdAt: string | null;
  ageHours: number | null;
  classifications: string[];
  pidDetails: PidDetail[];
};

type PidRow = {
  pid: string;
  description: string;
  classification: string;
  hsnCode: string;
  hsnClassification: string;
  required: number;
  picked: number;
  pending: number;
  shipmentCount: number;
};

type CatalogCacheStats = {
  hit: number;
  miss: number;
  coalesced: number;
};

const UNKNOWN_CATALOG: CatalogInfo = {
  classification: "Unknown",
  hsnCode: "",
  hsnClassification: "",
};

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function nonNegativeNumber(value: unknown): number {
  const normalized = typeof value === "string" ? value.replace(/,/g, "").trim() : value;
  const number = typeof normalized === "number" ? normalized : Number(normalized);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function nonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = typeof value === "string" ? value.replace(/,/g, "").trim() : value;
  const number = typeof normalized === "number" ? normalized : Number(normalized);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
}

function normalizeStatus(value: unknown): string {
  const status = textValue(value);
  if (!status) return "UNKNOWN";
  return status
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "UNKNOWN";
}

function isActiveStatus(status: string): boolean {
  return !TERMINAL_STATUSES.has(status);
}

function dateKeyInTimeZone(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function parseNexsTimestamp(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let normalized = trimmed.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) normalized += "T00:00:00+05:30";
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)) {
    normalized += "+05:30";
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function ageHours(createdAt: string | null, nowMs: number): number | null {
  const createdMs = parseNexsTimestamp(createdAt);
  return createdMs === null ? null : Math.max(0, (nowMs - createdMs) / 3_600_000);
}

function endpoint(path: string): URL {
  return new URL(path, NEXS_BASE_URL);
}

async function getNexsJson(
  request: Request,
  url: URL,
  appId: string,
  workstation = process.env.NEXS_WORKSTATION || "QC01",
): Promise<unknown> {
  return withAuthRetry(request, appId, "cookie", (auth) => fetchJson<unknown>(url.toString(), {
    method: "GET",
    headers: {
      ...operationalHeaders(FACILITY, workstation),
      ...auth,
    },
  }, NEXS_TIMEOUT_MS));
}

function splitIntoChunks<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function parseShipmentPage(payload: unknown): {
  shipments: RawShipment[];
  total: number | null;
  received: number;
  invalid: number;
} {
  const data = asRecord(asRecord(payload)?.data);
  const source = Array.isArray(data?.doOrderResponses) ? data.doOrderResponses : [];
  const shipments: RawShipment[] = [];
  let invalid = 0;

  for (const item of source) {
    const row = asRecord(item);
    const id = textValue(row?.shippingPackageId);
    if (!row || !id) {
      invalid += 1;
      continue;
    }
    shipments.push({
      id,
      status: normalizeStatus(row.status),
      createdAt: textValue(row.createdAt) || null,
    });
  }

  return {
    shipments,
    total: nonNegativeInteger(data?.totalCount),
    received: source.length,
    invalid,
  };
}

async function fetchShipments(
  request: Request,
  from: string,
  to: string,
  warnings: DashboardWarning[],
): Promise<{
  rows: RawShipment[];
  apiReportedTotal: number | null;
  duplicatesRemoved: number;
}> {
  const unique = new Map<string, RawShipment>();
  let apiReportedTotal: number | null = null;
  let offset = 0;
  let validReceived = 0;
  let invalidReceived = 0;
  let moreExpected = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = endpoint(ENDPOINTS.shipments);
    url.searchParams.set("sortKey", "created_at");
    url.searchParams.set("sortOrder", "DESC");
    url.searchParams.set("channel", CHANNEL);
    url.searchParams.set("created_at_from", `${from} 00:00:00`);
    url.searchParams.set("created_at_to", `${to} 23:59:59`);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("pageSize", String(PAGE_SIZE));

    let parsed: ReturnType<typeof parseShipmentPage>;
    try {
      parsed = parseShipmentPage(await getNexsJson(request, url, APP_IDS.shipments));
    } catch (error) {
      if (page === 0) throw error;
      warnings.push({
        code: "SHIPMENT_PAGE_FAILED",
        message: "A later shipment page could not be loaded; the dashboard contains a partial list.",
      });
      moreExpected = false;
      break;
    }

    if (apiReportedTotal === null && parsed.total !== null) apiReportedTotal = parsed.total;
    invalidReceived += parsed.invalid;
    validReceived += parsed.shipments.length;
    parsed.shipments.forEach((shipment) => unique.set(shipment.id, shipment));
    offset += parsed.received;

    if (parsed.received === 0) {
      moreExpected = false;
      break;
    }
    if (apiReportedTotal !== null && offset >= apiReportedTotal) {
      moreExpected = false;
      break;
    }
    if (apiReportedTotal === null && parsed.received < PAGE_SIZE) {
      moreExpected = false;
      break;
    }
    moreExpected = true;
  }

  if (moreExpected) {
    warnings.push({
      code: "SHIPMENT_PAGE_LIMIT",
      message: `The ${(MAX_PAGES * PAGE_SIZE).toLocaleString("en-IN")} shipment safety limit was reached; newer configuration may be required.`,
    });
  }
  if (invalidReceived > 0) {
    warnings.push({
      code: "INVALID_SHIPMENTS",
      message: "Some shipment records had no usable shipping ID and were ignored.",
      affected: invalidReceived,
    });
  }

  return {
    rows: [...unique.values()],
    apiReportedTotal,
    duplicatesRemoved: Math.max(0, validReceived - unique.size),
  };
}

function parseShipmentDetail(payload: unknown): ShipmentDetail {
  const data = asRecord(asRecord(payload)?.data);
  if (!data || Object.keys(data).length === 0) throw new Error("The shipment detail payload was empty.");

  const source = Array.isArray(data.pidListing) ? data.pidListing : [];
  const pids: RawPid[] = [];
  let malformedPidLines = 0;

  for (const item of source) {
    const row = asRecord(item);
    if (!row) {
      malformedPidLines += 1;
      continue;
    }
    pids.push({
      productId: textValue(row.productId) || null,
      description: textValue(row.description),
      required: nonNegativeNumber(row.requiredQuantity),
      scanned: nonNegativeNumber(row.quantityScanned),
    });
  }

  return {
    status: textValue(data.status) || null,
    customer: textValue(data.customerName) || "—",
    doNumber: textValue(data.doNumber) || "—",
    pids,
    malformedPidLines,
  };
}

async function fetchShipmentDetails(
  request: Request,
  candidates: RawShipment[],
  warnings: DashboardWarning[],
): Promise<{ rows: DetailedShipment[]; failed: number; malformedPidLines: number }> {
  const attempts = await mapLimit(candidates, DETAIL_CONCURRENCY, async (shipment) => {
    const url = endpoint(ENDPOINTS.details);
    url.searchParams.set("offset", "0");
    url.searchParams.set("sortKey", "updatedOn");
    url.searchParams.set("sortOrder", "DESC");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("id", shipment.id);
    try {
      const result = await cached(
        cacheKey("do-order-visibility:shipment-detail", {
          version: 1,
          facility: FACILITY,
          shippingPackageId: shipment.id,
        }),
        SHIPMENT_DETAIL_CACHE_TTL_MS,
        async () => parseShipmentDetail(await getNexsJson(request, url, APP_IDS.wms)),
      );
      return { shipment, detail: result.value };
    } catch {
      return { shipment, detail: null };
    }
  });

  const failed = attempts.filter((attempt) => attempt.detail === null).length;
  if (failed > 0) {
    warnings.push({
      code: "SHIPMENT_DETAILS_PARTIAL",
      message: "Some active shipments could not be enriched and are excluded from quantity totals.",
      affected: failed,
    });
  }

  let malformedPidLines = 0;
  const rows: DetailedShipment[] = [];
  attempts.forEach(({ shipment, detail }) => {
    if (!detail) return;
    malformedPidLines += detail.malformedPidLines;
    rows.push({
      source: shipment,
      detail,
      status: normalizeStatus(detail.status || shipment.status),
    });
  });

  return { rows, failed, malformedPidLines };
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

async function fetchDoMetadata(
  request: Request,
  shipments: DetailedShipment[],
  warnings: DashboardWarning[],
): Promise<Map<string, DoMeta>> {
  const doNumbers = [...new Set(
    shipments.map(({ detail }) => detail.doNumber).filter((value) => value && value !== "—"),
  )];
  if (doNumbers.length === 0) return new Map();

  const chunks = splitIntoChunks(doNumbers, 30);
  const attempts = await mapLimit(chunks, META_CONCURRENCY, async (chunk) => {
    const url = endpoint(ENDPOINTS.orders);
    url.searchParams.set("page", "0");
    url.searchParams.set("size", String(chunk.length));
    url.searchParams.set("sortBy", "createdAt");
    url.searchParams.set("sortOrder", "DESC");
    url.searchParams.set("searchTerms", `incrementId.in:${chunk.join(",")}___facility.eq:${FACILITY}`);
    try {
      const payload = await getNexsJson(request, url, APP_IDS.oms);
      const content = asRecord(asRecord(payload)?.data)?.content;
      const orders = Array.isArray(content) ? content : [];
      return { orders, failed: false };
    } catch {
      return { orders: [] as unknown[], failed: true };
    }
  });

  const failedChunks = attempts.filter((attempt) => attempt.failed).length;
  if (failedChunks > 0) {
    warnings.push({
      code: "DO_METADATA_PARTIAL",
      message: "Some DO type and PO lookups failed; affected shipments appear as Unknown.",
      affected: failedChunks,
    });
  }

  const exact = new Map<string, DoMeta>();
  const digitMatches = new Map<string, { incrementId: string; meta: DoMeta; ambiguous: boolean }>();
  attempts.forEach(({ orders }) => {
    orders.forEach((item) => {
      const order = asRecord(item);
      const incrementId = textValue(order?.incrementId);
      if (!incrementId) return;
      const meta = {
        doType: textValue(order?.doType) || "—",
        poNumber: textValue(order?.poNumber) || "—",
      };
      exact.set(incrementId, meta);

      const digits = digitsOnly(incrementId);
      if (!digits) return;
      const existing = digitMatches.get(digits);
      if (!existing) digitMatches.set(digits, { incrementId, meta, ambiguous: false });
      else if (existing.incrementId !== incrementId) existing.ambiguous = true;
    });
  });

  const result = new Map<string, DoMeta>();
  shipments.forEach(({ source, detail }) => {
    const exactMatch = exact.get(detail.doNumber);
    if (exactMatch) {
      result.set(source.id, exactMatch);
      return;
    }
    const digits = digitsOnly(detail.doNumber);
    const fallback = digits ? digitMatches.get(digits) : undefined;
    if (fallback && !fallback.ambiguous) result.set(source.id, fallback.meta);
  });
  return result;
}

function classifyHsn(rawClassification: string, hsnCode: string): string {
  const raw = rawClassification.trim();
  const normalized = raw.toLowerCase();
  if (normalized.includes("prescription") && normalized.includes("blank")) return "Prescription Blank";
  if (normalized.includes("solution") || normalized.includes("care")) return "Contact Lens Solution";
  if (normalized.includes("contact")) return "Contact Lens";
  if (normalized.includes("frame")) return "Eyeframe";
  if (hsnCode.startsWith("900130")) return "Contact Lens";
  if (hsnCode.startsWith("9003")) return "Eyeframe";
  if (hsnCode.startsWith("3307") || hsnCode.startsWith("3808")) return "Contact Lens Solution";
  if (!raw) return "Unknown";
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function parseCatalog(payload: unknown): CatalogInfo {
  const details = asRecord(asRecord(asRecord(payload)?.data)?.productDetailsResponse);
  const hsnClassification = textValue(details?.hsnClassification);
  const hsnCode = textValue(details?.hsnCode);
  return {
    hsnClassification,
    hsnCode,
    classification: classifyHsn(hsnClassification, hsnCode),
  };
}

async function fetchCatalog(
  request: Request,
  productIds: string[],
  warnings: DashboardWarning[],
): Promise<{ values: Map<string, CatalogInfo>; cache: CatalogCacheStats; failed: number }> {
  const cacheStats: CatalogCacheStats = { hit: 0, miss: 0, coalesced: 0 };
  const attempts = await mapLimit(productIds, CATALOG_CONCURRENCY, async (pid) => {
    const key = cacheKey("do-order-visibility:catalog", {
      pid,
      facility: FACILITY,
      appId: APP_IDS.catalog,
    });
    try {
      const result = await cached<CatalogInfo>(key, CATALOG_CACHE_TTL_MS, async () => {
        const url = endpoint(ENDPOINTS.catalog);
        url.searchParams.set("pid", pid);
        return parseCatalog(await getNexsJson(request, url, APP_IDS.catalog, "7"));
      });
      return { pid, value: result.value, cacheStatus: result.cache.status };
    } catch {
      return { pid, value: null, cacheStatus: null };
    }
  });

  const values = new Map<string, CatalogInfo>();
  let failed = 0;
  attempts.forEach(({ pid, value, cacheStatus }) => {
    if (!value || !cacheStatus) {
      failed += 1;
      values.set(pid, UNKNOWN_CATALOG);
      return;
    }
    cacheStats[cacheStatus] += 1;
    values.set(pid, value);
  });

  if (failed > 0) {
    warnings.push({
      code: "CATALOG_PARTIAL",
      message: "Some product classifications could not be loaded and are shown as Unknown.",
      affected: failed,
    });
  }
  return { values, cache: cacheStats, failed };
}

function isExcludedClassification(classification: string): boolean {
  return EXCLUDED_CLASSIFICATIONS.has(classification.trim().toLowerCase());
}

type LocalPidAggregate = {
  productId: string | null;
  description: string;
  classification: string;
  hsnCode: string;
  hsnClassification: string;
  required: number;
  picked: number;
};

type GlobalPidAggregate = Omit<PidRow, "pending" | "shipmentCount"> & {
  shipments: Set<string>;
};

function consolidate(
  shipments: DetailedShipment[],
  doMetadata: Map<string, DoMeta>,
  catalog: Map<string, CatalogInfo>,
  nowMs: number,
): {
  shipments: ShipmentRow[];
  pids: PidRow[];
  blankUnitsRemoved: number;
  blankOnlyShipmentsHidden: number;
  emptyShipmentsHidden: number;
  unidentifiedPidLines: number;
} {
  const shipmentRows: ShipmentRow[] = [];
  const globalPids = new Map<string, GlobalPidAggregate>();
  let blankUnitsRemoved = 0;
  let blankOnlyShipmentsHidden = 0;
  let emptyShipmentsHidden = 0;
  let unidentifiedPidLines = 0;

  shipments.forEach(({ source, detail, status }) => {
    const complete = FULLY_PICKED_STATUSES.has(status);
    const included: Array<{ pid: RawPid; info: CatalogInfo }> = [];

    detail.pids.forEach((pid) => {
      const info = pid.productId ? catalog.get(pid.productId) || UNKNOWN_CATALOG : UNKNOWN_CATALOG;
      if (isExcludedClassification(info.classification)) {
        blankUnitsRemoved += pid.required;
        return;
      }
      if (!pid.productId) unidentifiedPidLines += 1;
      included.push({ pid, info });
    });

    if (included.length === 0) {
      if (detail.pids.length > 0) blankOnlyShipmentsHidden += 1;
      else emptyShipmentsHidden += 1;
      return;
    }

    const localPids = new Map<string, LocalPidAggregate>();
    included.forEach(({ pid, info }) => {
      const key = pid.productId ? `pid:${pid.productId}` : "missing-product-id";
      const picked = complete ? pid.required : Math.min(pid.required, pid.scanned);
      const existing = localPids.get(key);
      if (existing) {
        existing.required += pid.required;
        existing.picked += picked;
        if (!existing.description && pid.description) existing.description = pid.description;
        return;
      }
      localPids.set(key, {
        productId: pid.productId,
        description: pid.description,
        classification: info.classification,
        hsnCode: info.hsnCode,
        hsnClassification: info.hsnClassification,
        required: pid.required,
        picked,
      });
    });

    const pidDetails: PidDetail[] = [...localPids.values()]
      .map((pid) => ({
        productId: pid.productId,
        description: pid.description,
        classification: pid.classification,
        required: pid.required,
        picked: pid.picked,
        pending: Math.max(0, pid.required - pid.picked),
      }))
      .sort((a, b) => b.pending - a.pending || (a.productId || "").localeCompare(b.productId || ""));

    const required = pidDetails.reduce((sum, pid) => sum + pid.required, 0);
    const picked = pidDetails.reduce((sum, pid) => sum + pid.picked, 0);
    const validPidCount = pidDetails.filter((pid) => pid.productId !== null).length;
    const meta = doMetadata.get(source.id);

    shipmentRows.push({
      id: source.id,
      status,
      customer: detail.customer,
      doNumber: detail.doNumber,
      poNumber: meta?.poNumber || "—",
      doType: meta?.doType || "—",
      required,
      picked,
      pending: Math.max(0, required - picked),
      pidCount: validPidCount,
      createdAt: source.createdAt,
      ageHours: ageHours(source.createdAt, nowMs),
      classifications: [...new Set(pidDetails.map((pid) => pid.classification))].sort(),
      pidDetails,
    });

    localPids.forEach((pid) => {
      if (!pid.productId) return;
      const existing = globalPids.get(pid.productId);
      if (existing) {
        existing.required += pid.required;
        existing.picked += pid.picked;
        existing.shipments.add(source.id);
        if (!existing.description && pid.description) existing.description = pid.description;
        return;
      }
      globalPids.set(pid.productId, {
        pid: pid.productId,
        description: pid.description,
        classification: pid.classification,
        hsnCode: pid.hsnCode,
        hsnClassification: pid.hsnClassification,
        required: pid.required,
        picked: pid.picked,
        shipments: new Set([source.id]),
      });
    });
  });

  shipmentRows.sort((a, b) => b.pending - a.pending || (b.ageHours || 0) - (a.ageHours || 0) || a.id.localeCompare(b.id));
  const pidRows = [...globalPids.values()]
    .map((pid) => ({
      pid: pid.pid,
      description: pid.description,
      classification: pid.classification,
      hsnCode: pid.hsnCode,
      hsnClassification: pid.hsnClassification,
      required: pid.required,
      picked: pid.picked,
      pending: Math.max(0, pid.required - pid.picked),
      shipmentCount: pid.shipments.size,
    }))
    .sort((a, b) => b.pending - a.pending || b.shipmentCount - a.shipmentCount || a.pid.localeCompare(b.pid));

  return {
    shipments: shipmentRows,
    pids: pidRows,
    blankUnitsRemoved,
    blankOnlyShipmentsHidden,
    emptyShipmentsHidden,
    unidentifiedPidLines,
  };
}

async function buildDashboard(request: Request, from: string, to: string) {
  const warnings: DashboardWarning[] = [];
  const shipmentResult = await fetchShipments(request, from, to, warnings);
  const initialActive = shipmentResult.rows.filter((shipment) => isActiveStatus(shipment.status));
  const dispatched = shipmentResult.rows.filter((shipment) => DISPATCHED_STATUSES.has(shipment.status)).length;
  const terminalExcluded = shipmentResult.rows.length - initialActive.length;

  const detailsResult = await fetchShipmentDetails(request, initialActive, warnings);
  const activeDetailed = detailsResult.rows.filter((shipment) => isActiveStatus(shipment.status));
  const terminalAfterDetail = detailsResult.rows.length - activeDetailed.length;
  if (terminalAfterDetail > 0) {
    warnings.push({
      code: "STATUS_CHANGED_DURING_REFRESH",
      message: "Some shipments reached a terminal status while the dashboard was loading and were excluded.",
      affected: terminalAfterDetail,
    });
  }
  if (detailsResult.malformedPidLines > 0) {
    warnings.push({
      code: "MALFORMED_PID_LINES",
      message: "Some malformed PID lines were ignored.",
      affected: detailsResult.malformedPidLines,
    });
  }

  const productIds = [...new Set(activeDetailed.flatMap(({ detail }) =>
    detail.pids.map((pid) => pid.productId).filter((pid): pid is string => Boolean(pid)),
  ))];
  const [doMetadata, catalogResult] = await Promise.all([
    fetchDoMetadata(request, activeDetailed, warnings),
    fetchCatalog(request, productIds, warnings),
  ]);

  const generatedAt = new Date();
  const consolidated = consolidate(activeDetailed, doMetadata, catalogResult.values, generatedAt.getTime());
  const unmatchedDoType = consolidated.shipments.filter((shipment) => shipment.doType === "—").length;
  if (unmatchedDoType > 0) {
    warnings.push({
      code: "UNMATCHED_DO_TYPE",
      message: "Some displayed shipments could not be matched to a DO type and appear as Unknown.",
      affected: unmatchedDoType,
    });
  }
  if (consolidated.unidentifiedPidLines > 0) {
    warnings.push({
      code: "UNIDENTIFIED_PID_LINES",
      message: "Some quantity lines had no product ID; shipment totals include them but PID totals do not.",
      affected: consolidated.unidentifiedPidLines,
    });
  }

  return {
    ok: true as const,
    generatedAt: generatedAt.toISOString(),
    range: { from, to, timeZone: TIME_ZONE },
    configuration: {
      facility: FACILITY,
      channel: CHANNEL,
      lookbackDays: LOOKBACK_DAYS,
      excludedClassifications: ["Prescription Blank"],
    },
    summary: {
      apiReportedTotal: shipmentResult.apiReportedTotal,
      fetchedTotal: shipmentResult.rows.length,
      duplicatesRemoved: shipmentResult.duplicatesRemoved,
      dispatched,
      terminalExcluded,
      activeFromList: initialActive.length,
      detailFailures: detailsResult.failed,
      terminalAfterDetail,
      blankUnitsRemoved: consolidated.blankUnitsRemoved,
      blankOnlyShipmentsHidden: consolidated.blankOnlyShipmentsHidden,
      emptyShipmentsHidden: consolidated.emptyShipmentsHidden,
      unmatchedDoType,
      catalogFailures: catalogResult.failed,
      catalogCache: catalogResult.cache,
      shownShipments: consolidated.shipments.length,
      impactedPids: consolidated.pids.length,
    },
    warnings,
    shipments: consolidated.shipments,
    pids: consolidated.pids,
  };
}

function clientSafeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || /abort|timed out/i.test(error.message)) {
      return "A NexS request timed out. Please try again.";
    }
    if (/authentication|login failed|not configured/i.test(error.message)) {
      return "NexS authentication is unavailable. Check the server credentials and endpoint app IDs.";
    }
  }
  return "Unable to load DO visibility data from NexS.";
}

async function serveDashboard(request: Request, refresh: boolean): Promise<NextResponse> {
  const today = dateKeyInTimeZone(new Date());
  const from = shiftDateKey(today, -(LOOKBACK_DAYS - 1));
  const key = cacheKey("do-order-visibility:dashboard", {
    version: 2,
    facility: FACILITY,
    channel: CHANNEL,
    from,
    to: today,
  });

  try {
    const result = await cached(key, FULL_CACHE_TTL_MS, () => buildDashboard(request, from, today), refresh);
    return NextResponse.json({
      ...result.value,
      cache: result.cache,
    }, {
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  } catch (error) {
    console.error("[do-order-visibility] Dashboard load failed:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ ok: false, error: clientSafeError(error) }, {
      status: 502,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    });
  }
}

export async function GET(request: Request) {
  const refresh = new URL(request.url).searchParams.get("refresh") === "true";
  return serveDashboard(request, refresh);
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const refresh = asRecord(body)?.refresh === true;
  return serveDashboard(request, refresh);
}
