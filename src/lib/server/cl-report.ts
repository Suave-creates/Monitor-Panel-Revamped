// src/lib/server/cl-report.ts
//
// Server-side business logic for the CL Report tab — same
// monitoring/v3/details API and GroupedOrder/buildMonitoringBody/
// groupOrders/JIT-flag pattern as Dispatch Report's server lib, but
// CL-FR0 / Bulk (CL/CLS) are a narrowing FILTER here (like Delay
// Report's FR1/FR2 filter), not a second card axis — the STAGE is the
// report's primary axis:
//
//   CL   — frTag "CL",   itemType []                                  (CL-FR0, retail CL/CLS)
//   BULK — frTag "BULK", itemType ["CONTACT_LENS","CONTACT_LENS_SOLUTION"] (bulk CL/CLS)
//
// Ported from curl captures against /nexs/analytics/monitoring/v3/details
// for both frTags, covering the pipeline: Synced -> Pending Picking ->
// In Picking -> Order QC -> Packing -> Manifest, plus the terminal
// "Shipment Not Generated" exception and (CL only, per the captures
// given) two QC-Fail rework sub-buckets. Ready To Ship is intentionally
// not tracked here (explicit correction). One API call per (category,
// stage) pair returns an already-homogeneous order list — no rank-based
// sub-status derivation needed, just group-by-Shipping-Package-ID,
// exactly like Dispatch Report.

export type RawRow = Record<string, unknown>;

function str(row: RawRow, key: string): string {
  const value = row[key];
  return value === null || value === undefined ? "" : String(value);
}
function num(row: RawRow, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

const JIT_FLAG_FIELDS = ["Jit Flag", "JIT Flag", "Is Jit", "isJit", "jitFlag", "JIT"];

export function asBool(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y" || s === "jit";
}

export function rowIsJit(row: RawRow): boolean {
  for (const key of JIT_FLAG_FIELDS) {
    const value = row[key];
    if (value !== undefined && value !== "" && value != null) return asBool(value);
  }
  const s = String(row["Jit Group Status"] ?? "").trim().toLowerCase();
  if (!s) return false;
  return !(s === "false" || s === "non_jit" || s === "non-jit" || s === "nonjit" || s === "no");
}

/* ── Categories & stages ─────────────────────────────────────────────
   frTag + itemType is what actually discriminates a category at the
   API; stages lists which statuses apply. BULK's itemType filter
   (CONTACT_LENS + CONTACT_LENS_SOLUTION) is what the "Bulk" side of
   the CL Report filter selects for — see the curl captures under
   "BULK (CL/CLS)". QC-Fail's two rework sub-buckets were only
   captured for CL, not BULK, so they're scoped to CL's stage list
   only — if BULK genuinely also runs them, add
   QC_FAIL_PENDING_PICKING / QC_FAIL_IN_PICKING to BULK.stages once
   confirmed against a live pull. */
export type DeptKey = "CL" | "BULK";
export type StageKey =
  | "SYNCED" | "PENDING_PICKING" | "IN_PICKING" | "ORDER_QC" | "PACKING" | "MANIFEST"
  | "SHIPMENT_NOT_GENERATED" | "QC_FAIL_PENDING_PICKING" | "QC_FAIL_IN_PICKING";

export type DeptConfig = { label: string; frTag: string; itemType: string[]; stages: StageKey[] };

// Ready To Ship intentionally excluded per explicit correction — this
// report tracks CL-FR0 / Bulk (CL/CLS) up through Manifest only.
const CORE_STAGES: StageKey[] = ["SYNCED", "PENDING_PICKING", "IN_PICKING", "ORDER_QC", "PACKING", "MANIFEST", "SHIPMENT_NOT_GENERATED"];

export const DEPTS: Record<DeptKey, DeptConfig> = {
  CL: { label: "CL-FR0", frTag: "CL", itemType: [], stages: [...CORE_STAGES, "QC_FAIL_PENDING_PICKING", "QC_FAIL_IN_PICKING"] },
  BULK: { label: "Bulk (CL/CLS)", frTag: "BULK", itemType: ["CONTACT_LENS", "CONTACT_LENS_SOLUTION"], stages: CORE_STAGES },
};
export const DEPT_ORDER: DeptKey[] = ["CL", "BULK"];

export const STAGE_META: Record<StageKey, { label: string; apiStatus: string }> = {
  SYNCED: { label: "Synced", apiStatus: "Synced" },
  PENDING_PICKING: { label: "Pending Picking", apiStatus: "Pending Picking" },
  IN_PICKING: { label: "In Picking", apiStatus: "In Picking" },
  ORDER_QC: { label: "Order QC", apiStatus: "Order QC" },
  PACKING: { label: "Packing", apiStatus: "Packing" },
  MANIFEST: { label: "Manifest", apiStatus: "Manifest" },
  SHIPMENT_NOT_GENERATED: { label: "Shipment Not Generated", apiStatus: "Shipment Not Generated" },
  QC_FAIL_PENDING_PICKING: { label: "QC Fail · Pending Picking", apiStatus: "QC Fail:::Pending Picking" },
  QC_FAIL_IN_PICKING: { label: "QC Fail · In Picking", apiStatus: "QC Fail:::In Picking" },
};
export const STAGE_ORDER: StageKey[] = [...CORE_STAGES, "QC_FAIL_PENDING_PICKING", "QC_FAIL_IN_PICKING"];

/* ── Orders ───────────────────────────────────────────────────────── */

export type OrderItem = {
  orderItemId: string;
  itemType: string;
  status: string;
  barcode: string;
  productId: string;
  lastUpdate: number;
};

export type GroupedOrder = {
  shippingPackageId: string;
  incrementId: string;
  fittingId: string;
  unicom: string;
  channel: string;
  trayNo: string;
  manifestNo: string;
  awbNo: string;
  courierCode: string;
  invoiceNo: string;
  createdAt: string;
  dwell: number;
  aging: number;
  jitFlag: boolean;
  status: string;
  itemCount: number;
  items: OrderItem[];
};

/** `itemTypeFilter` is applied HERE, against each row's own "Item Type"
 *  field — not trusted to the API's own itemType request parameter.
 *  Verified against a live capture: querying frTag=BULK with
 *  itemType:["CONTACT_LENS","CONTACT_LENS_SOLUTION"] in the request
 *  body still returns rows with "Item Type":"FRAME" (bulk eyeglass
 *  orders, not contact lenses) — the upstream filter isn't honored, so
 *  "Bulk (CL/CLS)" must re-filter the response itself to actually be
 *  CL/CLS-only. Rows are filtered out (not just excluded from the
 *  order's item list) before grouping, so a bulk order that's genuinely
 *  all-frame (no CL/CLS item at all) doesn't appear at all. */
export function groupOrders(rows: RawRow[], itemTypeFilter: string[] = []): GroupedOrder[] {
  const scopedRows = itemTypeFilter.length
    ? rows.filter((r) => itemTypeFilter.includes(str(r, "Item Type")))
    : rows;
  const map = new Map<string, GroupedOrder & { statusSet: Set<string> }>();
  for (const r of scopedRows) {
    const key = str(r, "Shipping Package ID") || str(r, "Fitting ID") || str(r, "Increment ID");
    if (!map.has(key)) {
      map.set(key, {
        shippingPackageId: str(r, "Shipping Package ID"),
        incrementId: str(r, "Increment ID"),
        fittingId: str(r, "Fitting ID"),
        unicom: str(r, "Unicom Order Code"),
        channel: str(r, "Channel"),
        trayNo: str(r, "Tray No"),
        manifestNo: str(r, "Manifest No"),
        awbNo: str(r, "AWB No"),
        courierCode: str(r, "Courier Code"),
        invoiceNo: str(r, "Invoice Number"),
        createdAt: str(r, "Created At"),
        dwell: num(r, "Last Update Since"),
        aging: num(r, "Order Aging"),
        jitFlag: false,
        status: "",
        itemCount: 0,
        items: [],
        statusSet: new Set<string>(),
      });
    }
    const o = map.get(key)!;
    o.items.push({
      orderItemId: str(r, "Order Item ID"),
      itemType: str(r, "Item Type"),
      status: str(r, "Current Status"),
      barcode: str(r, "Barcode"),
      productId: str(r, "Product ID"),
      lastUpdate: num(r, "Last Update Since"),
    });
    if (str(r, "Current Status")) o.statusSet.add(str(r, "Current Status"));
    if (!o.trayNo && str(r, "Tray No")) o.trayNo = str(r, "Tray No");
    if (!o.manifestNo && str(r, "Manifest No")) o.manifestNo = str(r, "Manifest No");
    if (!o.awbNo && str(r, "AWB No")) o.awbNo = str(r, "AWB No");
    if (!o.courierCode && str(r, "Courier Code")) o.courierCode = str(r, "Courier Code");
    o.dwell = Math.max(o.dwell, num(r, "Last Update Since"));
    o.aging = Math.max(o.aging, num(r, "Order Aging"));
    o.jitFlag = o.jitFlag || rowIsJit(r);
  }
  const out: GroupedOrder[] = [];
  for (const o of map.values()) {
    o.status = [...o.statusSet].join(" / ") || "UNKNOWN";
    o.itemCount = o.items.length;
    const { statusSet, ...rest } = o;
    void statusSet;
    out.push(rest);
  }
  return out;
}

export function applyJitFilter<T extends { jitFlag: boolean }>(orders: T[], jit: "all" | "jit" | "nonjit"): T[] {
  if (jit === "jit") return orders.filter((o) => o.jitFlag);
  if (jit === "nonjit") return orders.filter((o) => !o.jitFlag);
  return orders;
}

/* ── Request body ─────────────────────────────────────────────────── */

export type DateRange = { startValue: string; endValue: string };
export type International = "all" | "intl" | "nonintl";

export function buildMonitoringBody(
  deptKey: DeptKey,
  stageKey: StageKey,
  opts: { page: number; nddOnly: boolean; dateRange?: DateRange; pageSize?: number; international?: International },
): RawRow {
  const dept = DEPTS[deptKey];
  const { page, nddOnly, dateRange, pageSize = 500, international = "all" } = opts;
  const binaryFilter: RawRow = {};
  if (international === "intl") binaryFilter.isInternationalOrder = true;
  else if (international === "nonintl") binaryFilter.isInternationalOrder = false;
  return {
    page,
    pageSize,
    globalSearch: "",
    category: "FULFILLABLE_ORDERS",
    status: STAGE_META[stageKey].apiStatus,
    frTag: dept.frTag,
    version: "v3",
    monitorPanelFilters: {
      binaryFilter,
      singleSelectFilters: { errorType: "" },
      monitorPanelRangeFilters: {
        ageingSinceCreated: { startValue: 0, endValue: "-1" },
        ageingSinceLastUpdate: { startValue: 0, endValue: "-1" },
        date: dateRange || { startValue: "", endValue: "" },
      },
      multiSelectFilters: {
        pickingPriority: nddOnly ? [1] : [],
        qcStatus: [],
        itemType: dept.itemType,
        orderChannel: [],
      },
    },
  };
}
