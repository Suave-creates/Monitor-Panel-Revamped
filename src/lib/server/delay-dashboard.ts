// src/lib/server/delay-dashboard.ts
//
// Server-side business logic for the Delay Dashboard module — ONE feature,
// ONE panel, five views (Report / Stage / QC Fail / Warehouse / Packing &
// Dispatch) reached by client-side nav inside a single page, not five
// separate routes. This file is the single shared lib for that one
// feature (structure.md: "src/lib/server/<feature>.ts"), consolidated
// from what used to be five near-duplicate delay-*.ts files.
//
// Ported from the NexS Delay Dashboard's "Process Delay Dashboard for
// OMT2" Chrome extension (report.js / stage.js / qcfail.js), via the
// omt2-delay-dashboard webapp rebuild (server/src/lib/business.js).

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

export function normStatus(value: unknown): string {
  return String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/* ── QC / Fitting / MEI (report + stage drill-down) ─────────────────── */

export type OrderItem = {
  itemType: string;
  status: string;
  barcode: string;
  productId: string;
  lensType: string;
  lastUpdate: number;
  updatedAt?: string;
};

export type GroupedOrder = {
  shippingPackageId: string;
  incrementId: string;
  fittingId: string;
  unicom: string;
  channel: string;
  trayNo: string;
  powerType: string;
  jitStatus: string;
  createdAt: string;
  dwell: number;
  aging: number;
  jitFlag: boolean;
  frType: string | null;
  items: OrderItem[];
  status: string;
  lensType: string;
  curStatus: string;
  itemCount: number;
};

export type StageKey = "QC" | "FITTING" | "MEI";

export type StageConfig = {
  label: string;
  apiStatus: string;
  category: string;
  reportCols: string[];
  rank: Record<string, number>;
  holdCols: string[];
};

export const STAGES: Record<StageKey, StageConfig> = {
  QC: {
    label: "Order QC",
    apiStatus: "Order QC",
    category: "FULFILLABLE_ORDERS",
    reportCols: ["QC_HOLD", "IN_QC", "CUSTOMIZATION_COMPLETE"],
    rank: { QC_HOLD: -1, IN_QC: 0, CUSTOMIZATION_COMPLETE: 1, QC_DONE: 2 },
    holdCols: ["QC_HOLD"],
  },
  FITTING: {
    label: "Fitting",
    apiStatus: "Fitting",
    category: "FULFILLABLE_ORDERS",
    reportCols: ["PENDING_CUSTOMIZATION"],
    rank: { PENDING_CUSTOMIZATION: 0 },
    holdCols: [],
  },
  MEI: {
    label: "MEI",
    apiStatus: "MEI",
    category: "FULFILLABLE_ORDERS",
    reportCols: ["EDGING", "IN_TRAY"],
    rank: { IN_TRAY: 0, EDGING: 1 },
    holdCols: [],
  },
};

export function isStageKey(value: unknown): value is StageKey {
  return value === "QC" || value === "FITTING" || value === "MEI";
}

export const DWELL = [1, 2, 3] as const;
export const MEI_DWELL = [1, 3, 6] as const;

export function stuckestItem(items: OrderItem[]): OrderItem | null {
  if (!items.length) return null;
  return items.reduce((a, b) => {
    if (b.lastUpdate > a.lastUpdate) return b;
    if (b.lastUpdate < a.lastUpdate) return a;
    const bLens = /^(LEFT|RIGHT)LENS$/i.test(b.itemType || "");
    const aLens = /^(LEFT|RIGHT)LENS$/i.test(a.itemType || "");
    return bLens && !aLens ? a : b;
  });
}

export function deriveOrderStatus(items: OrderItem[], stageKey: StageKey): string {
  const rank = STAGES[stageKey].rank;
  const hold = items.find((i) => /HOLD/i.test(i.status || ""));
  if (hold) return hold.status;
  const lenses = items.filter((i) => {
    const t = String(i.itemType || "").toUpperCase().replace(/\s+/g, "");
    return t === "LEFTLENS" || t === "RIGHTLENS";
  });
  const pool = lenses.length ? lenses : items;
  let best: string | null = null;
  let bestR: number | null = null;
  for (const it of pool) {
    const r = rank[it.status] ?? 50;
    if (bestR === null || r < bestR) {
      bestR = r;
      best = it.status;
    }
  }
  return best || items[0]?.status || "UNKNOWN";
}

export function groupOrders(rows: RawRow[], stageKey: StageKey): GroupedOrder[] {
  const map = new Map<string, GroupedOrder & { lensSet: Set<string> }>();
  for (const r of rows) {
    const key = str(r, "Shipping Package ID") || str(r, "Fitting ID") || str(r, "Increment ID");
    if (!map.has(key)) {
      map.set(key, {
        shippingPackageId: str(r, "Shipping Package ID"),
        incrementId: str(r, "Increment ID"),
        fittingId: str(r, "Fitting ID"),
        unicom: str(r, "Unicom Order Code"),
        channel: str(r, "Channel"),
        trayNo: str(r, "Tray No"),
        powerType: str(r, "Power Type"),
        jitStatus: str(r, "Jit Group Status"),
        createdAt: str(r, "Created At"),
        dwell: num(r, "Last Update Since"),
        aging: num(r, "Order Aging"),
        jitFlag: rowIsJit(r),
        frType: null,
        items: [],
        status: "",
        lensType: "",
        curStatus: "",
        itemCount: 0,
        lensSet: new Set<string>(),
      });
    }
    const o = map.get(key)!;
    const itemType = String(r["Item Type"] ?? "").toUpperCase().replace(/[\s_-]+/g, "");
    const frTag = str(r, "FR Tag");
    if (!o.frType && frTag && (itemType === "FRAME" || itemType === "SUNGLASS" || itemType === "READINGGLASS")) {
      o.frType = frTag;
    }
    o.items.push({
      itemType: str(r, "Item Type"),
      status: str(r, "Current Status"),
      barcode: str(r, "Barcode"),
      productId: str(r, "Product ID"),
      lensType: str(r, "Lens Type"),
      lastUpdate: num(r, "Last Update Since"),
    });
    const lensType = str(r, "Lens Type");
    if (lensType) o.lensSet.add(lensType);
    o.dwell = Math.max(o.dwell, num(r, "Last Update Since"));
    o.aging = Math.max(o.aging, num(r, "Order Aging"));
    o.jitFlag = o.jitFlag || rowIsJit(r);
  }

  const out: GroupedOrder[] = [];
  for (const o of map.values()) {
    if (stageKey === "MEI") {
      const lenses = o.items.filter((i) =>
        String(i.itemType || "").toUpperCase().replace(/[\s_-]+/g, "").includes("LENS"));
      const pool = lenses.length > 0 ? lenses : o.items;
      const edging = pool.filter((i) => normStatus(i.status) === "EDGING");
      if (edging.length > 0) {
        o.status = "EDGING";
        const fr = edging.reduce((a, b) => (b.lastUpdate > a.lastUpdate ? b : a));
        o.dwell = fr.lastUpdate;
      } else {
        o.status = "IN_TRAY";
        const fr = stuckestItem(o.items);
        if (fr) o.dwell = fr.lastUpdate;
      }
    } else {
      o.status = deriveOrderStatus(o.items, stageKey);
    }
    o.lensType = [...o.lensSet].join(", ");
    o.curStatus = [...new Set(o.items.map((i) => i.status).filter(Boolean))].join(", ");
    o.itemCount = o.items.length;
    const { lensSet, ...rest } = o;
    void lensSet;
    out.push(rest);
  }
  return out;
}

export type StageStats = { total: number; g1: number; g2: number; g3: number; holds: number };

export function stageStats(orders: GroupedOrder[], stageKey: StageKey, dwt: readonly number[] = DWELL): StageStats {
  const cfg = STAGES[stageKey];
  let total = 0, g1 = 0, g2 = 0, g3 = 0, holds = 0;
  for (const o of orders) {
    if (!cfg.reportCols.includes(o.status)) continue;
    total++;
    if (o.dwell > dwt[2]) g3++;
    else if (o.dwell > dwt[1]) g2++;
    else if (o.dwell > dwt[0]) g1++;
    if (cfg.holdCols.includes(o.status)) holds++;
  }
  return { total, g1, g2, g3, holds };
}

export type Health = { cls: "ok" | "watch" | "alert" | "critical"; label: string };

export function health(st: { total: number; g1: number; g2: number; g3: number }): Health {
  const ge2 = st.g2 + st.g3;
  const ge1 = st.g1 + ge2;
  const p = st.total ? st.g3 / st.total : 0;
  if (p >= 0.10 || st.g3 > 20) return { cls: "critical", label: "CRITICAL" };
  if (p >= 0.05 || ge2 > 0) return { cls: "alert", label: "ALERT" };
  if (ge1 > 0) return { cls: "watch", label: "WATCH" };
  return { cls: "ok", label: "ON TRACK" };
}

export type DateRange = { startValue: string; endValue: string };
export type International = "all" | "intl" | "nonintl";

export function buildMonitoringBody(
  apiStatus: string,
  opts: {
    page: number;
    category: string;
    frTag: string;
    nddOnly: boolean;
    dateRange?: DateRange;
    pageSize?: number;
    qcFailFilter?: boolean;
    international?: International;
  },
): RawRow {
  const { page, category, frTag, nddOnly, dateRange, pageSize = 500, qcFailFilter = false, international = "all" } = opts;
  const binaryFilter: RawRow = {};
  if (international === "intl") binaryFilter.isInternationalOrder = true;
  else if (international === "nonintl") binaryFilter.isInternationalOrder = false;
  return {
    page,
    pageSize,
    globalSearch: "",
    category,
    status: apiStatus,
    frTag,
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
        qcStatus: qcFailFilter ? ["Fail"] : [],
        itemType: [],
        orderChannel: [],
        cxDoType: [],
      },
    },
  };
}

/* ── Frame type (fullrim/halfrim/rimless) — report view only ────────── */
const QCF_ACCESSORY = /(BAG|CASE|CLOTH|POUCH|COVER|SOLUTION|WIPE|FREEBIE|GIFT|BOX|CHAIN|CORD)/;

export const normFrame = (frameType: unknown): string =>
  String(frameType ?? "").toLowerCase().replace(/[^a-z]/g, "");

export function frameProductId(order: GroupedOrder): string | null {
  let explicit: string | null = null;
  let fallback: string | null = null;
  for (const it of order.items) {
    if (!it.productId) continue;
    const t = String(it.itemType || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (/LENS/.test(t)) continue;
    if (/FRAME|SUNGLASS|EYEFRAME/.test(t)) {
      explicit = it.productId;
      break;
    }
    if (!QCF_ACCESSORY.test(t) && fallback === null) fallback = it.productId;
  }
  return explicit || fallback;
}

/* ── Tagged orders (QC-Fail / Warehouse / Packing & Dispatch) ────────
   Shared row->order collapse for the three sub-stage-fetched views. */

export type TaggedOrder = {
  key: string;
  subKey: string;
  subLabel: string;
  shippingPackageId: string;
  incrementId: string;
  fittingId: string;
  unicom: string;
  channel: string;
  powerType: string;
  createdAt: string;
  trayNo: string;
  jit: string;
  jitFlag: boolean;
  aging: number;
  dwell: number;
  items: OrderItem[];
  frType: string | null;
  lensType: string;
  curStatus: string;
  itemCount: number;
};

export function groupTaggedOrders(rows: RawRow[], subKey: string, subLabel: string): TaggedOrder[] {
  const map = new Map<string, TaggedOrder & { lensSet: Set<string>; statusSet: Set<string> }>();
  for (const r of rows) {
    const key = str(r, "Shipping Package ID") || str(r, "Fitting ID") || str(r, "Increment ID");
    if (!map.has(key)) {
      map.set(key, {
        key, subKey, subLabel,
        shippingPackageId: str(r, "Shipping Package ID"),
        incrementId: str(r, "Increment ID"),
        fittingId: str(r, "Fitting ID"),
        unicom: str(r, "Unicom Order Code"),
        channel: str(r, "Channel"),
        powerType: str(r, "Power Type"),
        createdAt: str(r, "Created At"),
        trayNo: str(r, "Tray No"),
        jit: str(r, "Jit Group Status"),
        jitFlag: rowIsJit(r),
        aging: num(r, "Order Aging"),
        dwell: num(r, "Last Update Since"),
        items: [],
        lensSet: new Set<string>(),
        statusSet: new Set<string>(),
        frType: null,
        lensType: "",
        curStatus: "",
        itemCount: 0,
      });
    }
    const o = map.get(key)!;
    o.items.push({
      itemType: str(r, "Item Type"),
      status: str(r, "Current Status"),
      barcode: str(r, "Barcode"),
      productId: str(r, "Product ID"),
      lensType: str(r, "Lens Type"),
      lastUpdate: num(r, "Last Update Since"),
    });
    const lensType = str(r, "Lens Type");
    if (lensType) o.lensSet.add(lensType);
    const status = str(r, "Current Status");
    if (status) o.statusSet.add(status);
    o.dwell = Math.max(o.dwell, num(r, "Last Update Since"));
    o.aging = Math.max(o.aging, num(r, "Order Aging"));
    o.jitFlag = o.jitFlag || rowIsJit(r);
    const t = String(r["Item Type"] ?? "").toUpperCase().replace(/[^A-Z]/g, "");
    const frTag = str(r, "FR Tag");
    if (!o.frType && /FRAME|SUNGLASS|EYEFRAME/.test(t) && frTag) o.frType = frTag;
  }

  const out: TaggedOrder[] = [];
  for (const o of map.values()) {
    o.lensType = [...o.lensSet].join(", ");
    o.curStatus = [...o.statusSet].join(", ");
    o.itemCount = o.items.length;
    const { lensSet, statusSet, ...rest } = o;
    void lensSet; void statusSet;
    out.push(rest);
  }
  return out;
}

export type AggregateStats = { total: number; g1: number; g2: number; g3: number; holds: number };

export function aggregateStats(orders: TaggedOrder[], dwt: readonly number[] = DWELL): AggregateStats {
  let total = 0, g1 = 0, g2 = 0, g3 = 0;
  for (const o of orders) {
    total++;
    if (o.dwell > dwt[2]) g3++;
    else if (o.dwell > dwt[1]) g2++;
    else if (o.dwell > dwt[0]) g1++;
  }
  return { total, g1, g2, g3, holds: 0 };
}

/* ── Warehouse (start of pipeline) ───────────────────────────────────── */
export const WAREHOUSE_CATEGORY = "FULFILLABLE_ORDERS";
export const WAREHOUSE_SUBSTAGES = [
  { key: "SYNCED", api: "Synced", label: "Synced" },
  { key: "JIT_PROCESSING", api: "JIT Processing", label: "JIT Processing" },
  { key: "PENDING_PICKING", api: "Pending Picking", label: "Pending Picking" },
  { key: "IN_PICKING", api: "In Picking", label: "In Picking" },
  { key: "LENS_IN_PICKING", api: "Lens In Picking", label: "Lens In Picking" },
  { key: "TRAY_MAKING", api: "Tray Making", label: "Tray Making" },
  { key: "LENS_TRAY_MAKING", api: "Lens Tray Making", label: "Lens Tray Making" },
];

/* ── Packing & Dispatch (end of pipeline) ────────────────────────────── */
export const PACKING_DISPATCH_CATEGORY = "FULFILLABLE_ORDERS";
export const PACKING_DISPATCH_SUBSTAGES = [
  { key: "PACKING", api: "Packing", label: "Packing" },
  { key: "MANIFEST", api: "Manifest", label: "Manifest" },
];

/* ── QC-Fail rework pipeline ──────────────────────────────────────────
   Ten monitoring-API sub-statuses, fetched separately then merged by
   package key and re-classified via qcfSelect() using enriched
   fittingDetails items (the monitoring API hides items outside an
   order's current sub-stage). */
export const QCFAIL_CATEGORY = "FULFILLABLE_ORDERS";

export type QcfailSubstage = { key: string; api: string; label: string; qcFailFilter?: boolean };

export const QCFAIL_SUBSTAGES: QcfailSubstage[] = [
  { key: "PENDING_PICKING", api: "QC Fail:::Pending Picking", label: "PENDING PICKING" },
  { key: "IN_PICKING", api: "QC Fail:::In Picking", label: "IN PICKING" },
  { key: "LENS_IN_PICKING", api: "QC Fail:::Lens In Picking", label: "LENS IN PICKING" },
  { key: "LENS_TRAY_MAKING", api: "QC Fail:::Lens Tray Making", label: "LENS TRAY MAKING" },
  { key: "BLANK_IN_TRAY", api: "QC Fail:::Blank In Tray", label: "BLANK IN TRAY" },
  { key: "PRODUCTION_DONE", api: "QC Fail:::Production Done", label: "PRODUCTION DONE" },
  { key: "JIT_PR_RAISED", api: "QC Fail:::Jit Pr Raised", label: "JIT PR RAISED" },
  { key: "MEI", api: "QC Fail:::MEI", label: "MEI" },
  { key: "FITTING", api: "QC Fail:::Fitting", label: "FITTING" },
  { key: "ORDER_QC_REWORK", api: "Order QC", label: "BACK AT QC", qcFailFilter: true },
];

export function groupQcfOrders(rows: RawRow[], subKey: string): TaggedOrder[] {
  const sub = QCFAIL_SUBSTAGES.find((s) => s.key === subKey);
  return groupTaggedOrders(rows, subKey, sub?.label || subKey);
}

export const QCF_RANK = [
  "JIT_PROCESSING", "PENDING_PICKING", "JIT_PR_RAISED", "IN_PICKING", "LENS_IN_PICKING",
  "BLANK_IN_TRAY", "PRODUCTION_DONE", "PICKED", "IN_TRAY", "EDGING",
  "PENDING_CUSTOMIZATION", "CUSTOMIZATION_COMPLETE", "IN_QC", "QC_HOLD", "QC_DONE", "INVOICED",
];

export function qcfCanon(status: unknown): string {
  return normStatus(status).replace(/CUSTOMISATION/g, "CUSTOMIZATION");
}
export function qcfRank(status: unknown): number {
  const i = QCF_RANK.indexOf(qcfCanon(status));
  return i < 0 ? 999 : i;
}

export const QCF_STATUS_BUCKET: Record<string, string> = {
  JIT_PROCESSING: "ASRS", PENDING_PICKING: "ASRS", JIT_PR_RAISED: "ASRS",
  IN_PICKING: "ASRS", LENS_IN_PICKING: "ASRS", PICKED: "ASRS",
  IN_TRAY: "IN_TRAY",
  BLANK_IN_TRAY: "LL", PRODUCTION_DONE: "LL",
  EDGING: "MEI",
  PENDING_CUSTOMIZATION: "FITTING", PENDING_CUSTOMISATION: "FITTING", PENDING_CUST: "FITTING",
};

export function qcfBucketOfStatus(status: unknown): string | null {
  return QCF_STATUS_BUCKET[qcfCanon(status)] || null;
}

export function qcfIsCore(itemType: unknown): boolean {
  const t = String(itemType ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return t.length > 0 && !QCF_ACCESSORY.test(t);
}

export type QcfSelect = { bucket: string | null; item: OrderItem | null; edging: boolean; latest: number | null; tie: boolean };

export function qcfSelect(items: OrderItem[]): QcfSelect {
  const EMPTY: QcfSelect = { bucket: null, item: null, edging: false, latest: null, tie: false };
  if (!items.length) return EMPTY;
  const relevant = items.filter((i) => qcfIsCore(i.itemType));
  const pool = relevant.length > 0 ? relevant : items;
  if (!pool.length) return EMPTY;

  const edging = pool.filter((i) => qcfCanon(i.status) === "EDGING");
  if (edging.length) {
    const item = edging.reduce((a, b) => (b.lastUpdate < a.lastUpdate ? b : a));
    return { bucket: "MEI", item, edging: true, latest: item.lastUpdate, tie: false };
  }

  const minRank = pool.reduce((m, i) => Math.min(m, qcfRank(i.status)), 999);
  const atRank = pool.filter((i) => qcfRank(i.status) === minRank);
  const item = atRank.reduce((a, b) => (b.lastUpdate < a.lastUpdate ? b : a));

  return { bucket: qcfBucketOfStatus(item.status), item, edging: false, latest: item.lastUpdate, tie: atRank.length > 1 };
}

export type MergedOrder = TaggedOrder & { bucket: string | null; decidedStatus: string };

export function mergeQcfOrders(
  dataBySubKey: Record<string, TaggedOrder[] | undefined>,
  detailsByPackageId: Map<string, OrderItem[]>,
): MergedOrder[] {
  const merged = new Map<string, TaggedOrder>();
  for (const sub of QCFAIL_SUBSTAGES) {
    const orders = dataBySubKey[sub.key];
    if (!orders) continue;
    for (const o of orders) {
      if (!merged.has(o.key)) {
        merged.set(o.key, { ...o, items: [...o.items] });
      } else {
        const m = merged.get(o.key)!;
        m.items.push(...o.items);
        m.jitFlag = m.jitFlag || o.jitFlag;
      }
    }
  }
  const out: MergedOrder[] = [];
  merged.forEach((o) => {
    const cached = o.shippingPackageId ? detailsByPackageId.get(o.shippingPackageId) : undefined;
    const items = cached && cached.length ? cached : o.items;

    if (o.subKey === "ORDER_QC_REWORK") {
      out.push({
        ...o,
        items,
        bucket: "ORDER_QC_REWORK",
        subLabel: "BACK AT QC",
        decidedStatus: o.curStatus || "",
        curStatus: [...new Set(items.map((i) => i.status))].join(", "),
        lensType: [...new Set(items.map((i) => i.lensType).filter(Boolean))].join(", "),
        itemCount: items.length,
      });
      return;
    }

    const sel = qcfSelect(items);
    out.push({
      ...o,
      items,
      dwell: sel.item ? sel.item.lastUpdate : o.dwell,
      bucket: sel.bucket,
      subLabel: sel.bucket || o.subLabel,
      decidedStatus: sel.item ? sel.item.status : "",
      curStatus: [...new Set(items.map((i) => i.status))].join(", "),
      lensType: [...new Set(items.map((i) => i.lensType).filter(Boolean))].join(", "),
      itemCount: items.length,
    });
  });
  return out;
}

// fittingDetails returns zoneless UTC timestamps — parse as UTC, no offset
// correction (a prior IST auto-calibration heuristic was removed upstream
// after QC-fail orders poisoned it — do not reintroduce it).
export function hoursAgoUTC(ts: unknown): number {
  if (!ts) return NaN;
  let s = String(ts).trim();
  const ddmm = s.match(/^(\d{2})\/(\d{2})\/(\d{4})\s(.+)$/);
  if (ddmm) s = `${ddmm[3]}-${ddmm[2]}-${ddmm[1]} ${ddmm[4]}`;
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  const t = Date.parse(s.replace(" ", "T") + (hasZone ? "" : "Z"));
  return isNaN(t) ? NaN : (Date.now() - t) / 3_600_000;
}

export function hoursSince(ts: unknown): number {
  const h = hoursAgoUTC(ts);
  return isNaN(h) ? 0 : Math.max(0, h);
}
