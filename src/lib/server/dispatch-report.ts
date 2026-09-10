// src/lib/server/dispatch-report.ts
//
// Server-side business logic for the Dispatch Report module — the tail
// end of the fulfilment pipeline (Packing / Manifest / Ready To Ship),
// across six categories (FR1, FR2, FR0, FR0-BULK, CL/CLS-BULK, CL/CLS).
// One feature, one panel (structure.md: "src/lib/server/<feature>.ts").
//
// Ported from the "Dispatch Pendency Tracker" Chrome extension
// (dispatch.js / stage.js). Unlike the Delay Dashboard's OMT source,
// here one API call per (category, stage) pair returns an
// already-homogeneous order list — no rank-based sub-status derivation
// needed, just group-by-Shipping-Package-ID.

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

/** CAVEAT (carried over from the source extension): every sample row it
 *  was built from showed "Jit Group Status": null at Packing/Manifest/RTS
 *  for every category — so the JIT filter may return zero JIT results in
 *  practice if that field genuinely isn't populated this far down the
 *  pipeline. Not a bug in this filter if so. */
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
   API; stages lists which of Packing / Manifest / Ready To Ship apply. */
export type DeptKey = "FR1" | "FR2" | "FR0" | "FR0BULK" | "CLBULK" | "CL";
export type StageKey = "PACKING" | "MANIFEST" | "RTS";

export type DeptConfig = { label: string; frTag: string; itemType: string[]; stages: StageKey[] };

export const DEPTS: Record<DeptKey, DeptConfig> = {
  FR1: { label: "FR1", frTag: "FR1", itemType: [], stages: ["PACKING", "MANIFEST", "RTS"] },
  FR2: { label: "FR2", frTag: "FR2", itemType: [], stages: ["PACKING", "MANIFEST", "RTS"] },
  FR0: { label: "FR0", frTag: "FR0", itemType: [], stages: ["PACKING", "MANIFEST", "RTS"] },
  FR0BULK: { label: "FR0-BULK", frTag: "BULK", itemType: ["FRAME", "SUNGLASS", "ACCESSORIES"], stages: ["MANIFEST", "RTS"] },
  CLBULK: { label: "CL/CLS-BULK", frTag: "BULK", itemType: ["CONTACT_LENS", "CONTACT_LENS_SOLUTION"], stages: ["MANIFEST", "RTS"] },
  CL: { label: "CL/CLS", frTag: "CL", itemType: ["CONTACT_LENS", "CONTACT_LENS_SOLUTION"], stages: ["MANIFEST", "RTS"] },
};
export const DEPT_ORDER: DeptKey[] = ["FR1", "FR2", "FR0", "FR0BULK", "CLBULK", "CL"];

export const STAGE_META: Record<StageKey, { label: string; apiStatus: string }> = {
  PACKING: { label: "Packing", apiStatus: "Packing" },
  MANIFEST: { label: "Manifest", apiStatus: "Manifest" },
  RTS: { label: "Ready To Ship", apiStatus: "Ready To Ship" },
};
export const STAGE_ORDER: StageKey[] = ["PACKING", "MANIFEST", "RTS"];

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
 *  Verified against a live capture (CL Report's identical frTag=BULK
 *  pattern): querying with an itemType filter in the request body still
 *  returns rows whose "Item Type" doesn't match it — the upstream
 *  filter isn't honored, so FR0-BULK / CL-BULK must re-filter the
 *  response themselves. Rows are filtered out (not just excluded from
 *  the order's item list) before grouping, so an order with no matching
 *  item at all doesn't appear. */
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
