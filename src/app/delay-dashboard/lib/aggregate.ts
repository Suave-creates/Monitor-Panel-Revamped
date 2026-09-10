// src/app/delay-dashboard/lib/aggregate.ts
//
// Client-side presentation math for the Delay Dashboard's Report view
// (aging matrices, Department Summary, header KPIs) — and, since every
// number on the page is now a drill-down into the exact orders behind
// it, the canonical "one full order, tagged with its department and
// display column" shape (AgingItem) used throughout this module. Local
// to this one module — see Rules.md §1.

import type { OrderItem, QcfailOrder, StageOrder, TaggedOrder } from "../types";
import {
  classifyLensPids,
  isCoreItemType,
  isLensItemType,
  lensSideOf,
  LENS_CLASS_LABEL,
  matchesLensTypeFilter,
  type LensClass,
  type LensTypeFilter,
  type PidSets,
} from "./pidClassify";

export type StageKey = "QC" | "FITTING" | "MEI";
export type DeptKey = "WAREHOUSE" | "MEI" | "FITTING" | "QC" | "QCFAIL" | "PACKING_DISPATCH";
export type HealthCls = "ok" | "watch" | "alert" | "critical";

export type StagesData = Record<StageKey, { stats: unknown; orders: StageOrder[] }>;

/** The canonical drillable order shape — every Department Summary cell,
 *  aging-matrix cell, KPI number, and NDD Shift Report live cell is
 *  ultimately a filtered list of these. `status` is the raw column key
 *  (a status for QC/Fitting/MEI, a bucket for QC-Fail, a merged
 *  sub-stage label for Warehouse/Packing & Dispatch); `statusLabel` is
 *  what's shown on screen. `lensClass` and the per-component fields come
 *  from the NJIT PID Vault (src/app/delay-dashboard/lib/pidClassify.ts). */
export type AgingItem = {
  dept: DeptKey;
  incrementId: string;
  shippingPackageId: string;
  fittingId: string;
  unicom: string;
  status: string;
  statusLabel: string;
  channel: string;
  trayNo: string;
  lensType: string;
  powerType: string;
  jitStatus: string;
  jitFlag: boolean;
  dwell: number;
  aging: number;
  createdAt: string;
  items: OrderItem[];
  lensClass: LensClass;
  framePid: string;
  leftPid: string;
  rightPid: string;
  frameBarcode: string;
  leftBarcode: string;
  rightBarcode: string;
  frameStatus: string;
  leftStatus: string;
  rightStatus: string;
  frameUpdHr: number | "";
  leftUpdHr: number | "";
  rightUpdHr: number | "";
};

export const DEPT_ORDER: DeptKey[] = ["WAREHOUSE", "MEI", "FITTING", "QC", "QCFAIL", "PACKING_DISPATCH"];

export const DEPT_META: Record<DeptKey, { name: string; ico: string }> = {
  WAREHOUSE: { name: "WAREHOUSE", ico: "📦" },
  MEI: { name: "MEI", ico: "⚙" },
  FITTING: { name: "FITTING", ico: "🛠" },
  QC: { name: "QC", ico: "◷" },
  QCFAIL: { name: "QC FAIL", ico: "⚠" },
  PACKING_DISPATCH: { name: "PACKING & DISPATCH", ico: "🚚" },
};

export const COL_LABEL: Record<string, string> = {
  QC_HOLD: "QC HOLD", IN_QC: "IN QC", CUSTOMIZATION_COMPLETE: "CUST COMPLETE",
  PENDING_CUSTOMIZATION: "PENDING CUSTOMISATION", EDGING: "EDGING", IN_TRAY: "IN TRAY",
};
export const QCFAIL_BUCKET_LABELS: Record<string, string> = {
  ASRS: "ASRS", LL: "LL", IN_TRAY: "IN TRAY", MEI: "MEI", FITTING: "FITTING", ORDER_QC_REWORK: "BACK AT QC",
};
const REPORT_COLS: Record<string, string[]> = {
  QC: ["QC_HOLD", "IN_QC", "CUSTOMIZATION_COMPLETE"],
  FITTING: ["PENDING_CUSTOMIZATION"],
  MEI: ["EDGING", "IN_TRAY"],
};
const HOLD_COLS: Record<string, string[]> = { QC: ["QC_HOLD"], FITTING: [], MEI: [] };

export const WAREHOUSE_SUBSTAGE_LABELS = ["Synced", "JIT Processing", "Pending Picking", "In Picking"];
export const WAREHOUSE_LABEL_MERGE: Record<string, string> = {
  "Lens In Picking": "In Picking", "Tray Making": "In Picking", "Lens Tray Making": "In Picking",
};
export const PACKING_DISPATCH_SUBSTAGE_LABELS = ["Packing", "Manifest"];

export const DAY_COLS = ["0", "1", "2", "3", "4", "5", "6", "7", "7+"];
export const HOUR_COLS = [
  { key: "0-1", lo: 0, hi: 1, tier: "good" },
  { key: "1-2", lo: 1, hi: 2, tier: "watch" },
  { key: "2-4", lo: 2, hi: 4, tier: "delay" },
  { key: "4-6", lo: 4, hi: 6, tier: "high" },
  { key: "6-8", lo: 6, hi: 8, tier: "high" },
  { key: "8-12", lo: 8, hi: 12, tier: "high" },
  { key: "12-24", lo: 12, hi: 24, tier: "crit" },
  { key: "24-48", lo: 24, hi: 48, tier: "crit" },
  { key: "48+", lo: 48, hi: Infinity, tier: "crit" },
];
export function dayTier(col: string): string {
  if (col === "0" || col === "1") return "good";
  if (col === "2" || col === "3") return "watch";
  if (col === "4" || col === "5") return "delay";
  if (col === "6" || col === "7") return "high";
  return "crit";
}
export function dayBucketIdx(d: number): number { return d > 7 ? 8 : d; }
export function hourBucketIdx(h: number): number {
  for (let i = 0; i < HOUR_COLS.length; i++) { const c = HOUR_COLS[i]; if (h >= c.lo && h < c.hi) return i; }
  return HOUR_COLS.length - 1;
}

const IST_OFFSET_MS = 5.5 * 3_600_000;
function utcMs(raw: string | undefined): number {
  if (!raw) return NaN;
  const s = raw.trim();
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) { const p = Date.parse(s); return Number.isNaN(p) ? NaN : p; }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const p = Date.parse(s);
  return Number.isNaN(p) ? NaN : p;
}
function istDayIndex(msUtc: number): number {
  const d = new Date(msUtc + IST_OFFSET_MS);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
}
export function orderAgeDays(o: AgingItem): number {
  let ms = utcMs(o.createdAt);
  if (!Number.isFinite(ms) && Number.isFinite(o.aging) && o.aging > 0) ms = Date.now() - o.aging * 3_600_000;
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, istDayIndex(Date.now()) - istDayIndex(ms));
}

export type BucketDef = { op: ">" | "<" | "-"; hrs: number } | null;

function nextGtEdge(defs: Exclude<BucketDef, null>[], hrs: number): number | null {
  const ups = defs.filter((d) => d.op === ">" && d.hrs > 0).map((d) => d.hrs).filter((h) => h > hrs).sort((a, b) => a - b);
  return ups.length ? ups[0] : null;
}
export function bandHdrLabel(b: BucketDef): string {
  return !b || b.op === "-" ? "—" : b.hrs === 0 ? "0-1HR" : `${b.op === "<" ? "<" : ">"}${b.hrs}HR`;
}

/** One band's definition plus the exact orders that fall in it — the
 *  single source of truth for both a band's displayed count (list.length)
 *  and its drill-down (list itself). Exclusive: each order falls in
 *  exactly one band, mirroring the source extension's v1.5 model. */
export type Band = { def: Exclude<BucketDef, null>; list: AgingItem[] };

export function bandBuckets(list: AgingItem[], stageBuckets: BucketDef[]): (Band | null)[] {
  const defs = stageBuckets.filter((d): d is Exclude<BucketDef, null> => !!d);
  return defs.map((def) => {
    if (def.op === "-") return null;
    if (def.op === ">") {
      if (def.hrs === 0) return { def, list: list.filter((o) => Math.ceil(o.dwell || 0) === 1) };
      const edge = nextGtEdge(defs, def.hrs);
      return { def, list: list.filter((o) => { const u = Math.ceil(o.dwell || 0); return u > def.hrs && (edge == null || u <= edge); }) };
    }
    return { def, list: list.filter((o) => Math.ceil(o.dwell || 0) < def.hrs) };
  });
}
export function bandClass(i: number, n: number | null): string {
  if (n == null) return "v-dash";
  if (n === 0) return "v-zero";
  return ["v-warn", "v-hot", "v-crit"][i] || "v-crit";
}
export function activeBuckets(stageBuckets: BucketDef[] | undefined): Exclude<BucketDef, null>[] {
  return (stageBuckets || []).filter((d): d is Exclude<BucketDef, null> => !!d);
}

export const DEFAULT_BUCKETS: Record<DeptKey, BucketDef[]> = {
  WAREHOUSE: [{ op: ">", hrs: 1 }, { op: ">", hrs: 2 }, { op: ">", hrs: 3 }],
  QC: [{ op: ">", hrs: 1 }, { op: ">", hrs: 2 }, { op: ">", hrs: 3 }],
  FITTING: [{ op: ">", hrs: 1 }, { op: ">", hrs: 2 }, { op: ">", hrs: 3 }],
  MEI: [{ op: ">", hrs: 1 }, { op: ">", hrs: 3 }, { op: ">", hrs: 6 }],
  QCFAIL: [{ op: ">", hrs: 1 }, { op: ">", hrs: 2 }, { op: ">", hrs: 3 }],
  PACKING_DISPATCH: [{ op: ">", hrs: 1 }, { op: ">", hrs: 2 }, { op: ">", hrs: 3 }],
};

function toAgingItem(
  dept: DeptKey,
  o: {
    shippingPackageId: string; incrementId: string; fittingId?: string; unicom: string; channel: string; trayNo: string;
    lensType?: string; powerType?: string; jitStatus?: string; jit?: string;
    jitFlag: boolean; dwell: number; aging: number; createdAt: string; items: OrderItem[];
  },
  status: string,
  statusLabel: string,
  pidSets: PidSets,
): AgingItem {
  const items = o.items || [];
  const lensPids = [...new Set(items.filter((i) => isLensItemType(i.itemType) && i.productId).map((i) => i.productId))];
  const frame = items.find((i) => !isLensItemType(i.itemType) && isCoreItemType(i.itemType));
  const left = items.find((i) => lensSideOf(i.itemType) === "L");
  const right = items.find((i) => lensSideOf(i.itemType) === "R");
  const updHr = (i: OrderItem | undefined): number | "" => (i ? Math.round((i.lastUpdate || 0) * 100) / 100 : "");
  return {
    dept, incrementId: o.incrementId, shippingPackageId: o.shippingPackageId, fittingId: o.fittingId || "", unicom: o.unicom,
    status, statusLabel, channel: o.channel, trayNo: o.trayNo, jitFlag: o.jitFlag,
    lensType: o.lensType || "", powerType: o.powerType || "", jitStatus: o.jitStatus ?? o.jit ?? "",
    dwell: o.dwell || 0, aging: o.aging || 0, createdAt: o.createdAt || "",
    items,
    lensClass: classifyLensPids(lensPids, pidSets),
    framePid: frame?.productId || "", leftPid: left?.productId || "", rightPid: right?.productId || "",
    frameBarcode: frame?.barcode || "", leftBarcode: left?.barcode || "", rightBarcode: right?.barcode || "",
    frameStatus: frame?.status || "", leftStatus: left?.status || "", rightStatus: right?.status || "",
    frameUpdHr: updHr(frame), leftUpdHr: updHr(left), rightUpdHr: updHr(right),
  };
}

/** Client-side filter matching the NJIT PID Vault classification — the
 *  global "Lens Type" filter applies this after `deptOrdersMap` so every
 *  downstream view (Department Summary, aging matrices, KPIs, NDD Shift
 *  Report) sees only the matching orders. */
export function filterByLensType(items: AgingItem[], filter: LensTypeFilter): AgingItem[] {
  if (filter === "all") return items;
  return items.filter((o) => matchesLensTypeFilter(o.lensClass, filter));
}

const QCF_OVERLAP_BUCKET: Record<string, string> = { MEI: "MEI", FITTING: "FITTING", QC: "ORDER_QC_REWORK" };

function qcfOverlapIds(dept: string, qcfailOrders: QcfailOrder[]): Set<string> | null {
  const bucket = QCF_OVERLAP_BUCKET[dept];
  if (!bucket) return null;
  const ids = new Set<string>();
  qcfailOrders.forEach((o) => { if (o.bucket === bucket && o.shippingPackageId) ids.add(o.shippingPackageId); });
  return ids;
}

/** Raw MEI/FITTING/QC orders from the report fetch, with QC-Fail-rework
 *  duplicates removed (an order back for rework is physically sitting at
 *  MEI/Fitting/QC AND tagged by QC-Fail's own fetch — QC-Fail is the
 *  authoritative home for it). */
export function dedupedStageOrders(dept: StageKey, stages: StagesData, qcfailOrders: QcfailOrder[]): StageOrder[] {
  const raw = stages[dept]?.orders || [];
  const ids = qcfOverlapIds(dept, qcfailOrders);
  if (!ids || !ids.size) return raw;
  return raw.filter((o) => !ids.has(o.shippingPackageId));
}

export const DWELL = [1, 2, 3];

export function dedupedStageStats(dept: StageKey, orders: StageOrder[], dwt: number[] = DWELL) {
  const cols = REPORT_COLS[dept] || [];
  const holdCols = HOLD_COLS[dept] || [];
  let total = 0, g1 = 0, g2 = 0, g3 = 0, holds = 0;
  orders.forEach((o) => {
    if (!cols.includes(o.status)) return;
    total++;
    const dw = o.dwell || 0;
    const b = dw > dwt[2] ? 3 : dw > dwt[1] ? 2 : dw > dwt[0] ? 1 : 0;
    if (b === 3) g3++; else if (b === 2) g2++; else if (b === 1) g1++;
    if (holdCols.includes(o.status)) holds++;
  });
  return { total, g1, g2, g3, holds };
}

export function dedupedHealth(st: { total: number; g1: number; g2: number; g3: number }): { cls: HealthCls; label: string } {
  const ge2 = st.g2 + st.g3;
  const ge1 = st.g1 + ge2;
  const p = st.total ? st.g3 / st.total : 0;
  if (p >= 0.10 || st.g3 > 20) return { cls: "critical", label: "CRITICAL" };
  if (p >= 0.05 || ge2 > 0) return { cls: "alert", label: "ALERT" };
  if (ge1 > 0) return { cls: "watch", label: "WATCH" };
  return { cls: "ok", label: "ON TRACK" };
}

/** The full drillable order set for all six departments — the same data
 *  the Department Summary / aging matrices / KPI strip are built from,
 *  just not yet bucketed. Also exactly what the Report view's "download
 *  everything" dump exports. */
export function deptOrdersMap(
  stages: StagesData, qcfailOrders: QcfailOrder[], warehouseOrders: TaggedOrder[], packingDispatchOrders: TaggedOrder[],
  pidSets: PidSets,
): Record<DeptKey, AgingItem[]> {
  const out: Partial<Record<DeptKey, AgingItem[]>> = {};
  (["QC", "FITTING", "MEI"] as StageKey[]).forEach((dept) => {
    out[dept] = dedupedStageOrders(dept, stages, qcfailOrders).map((o) => toAgingItem(dept, o, o.status, COL_LABEL[o.status] || o.status, pidSets));
  });
  out.QCFAIL = qcfailOrders.map((o) => toAgingItem("QCFAIL", o, o.bucket || "", QCFAIL_BUCKET_LABELS[o.bucket || ""] || o.subLabel, pidSets));
  out.WAREHOUSE = warehouseOrders.map((o) => {
    const merged = WAREHOUSE_LABEL_MERGE[o.subLabel] || o.subLabel;
    return toAgingItem("WAREHOUSE", o, merged, merged, pidSets);
  });
  out.PACKING_DISPATCH = packingDispatchOrders.map((o) => toAgingItem("PACKING_DISPATCH", o, o.subLabel, o.subLabel, pidSets));
  return out as Record<DeptKey, AgingItem[]>;
}

export type MatrixRow = { dept: DeptKey; meta: { name: string; ico: string }; cells: AgingItem[][]; total: number };

export function daysMatrixRows(deptOrders: Record<DeptKey, AgingItem[]>, depts: DeptKey[] = DEPT_ORDER): MatrixRow[] {
  return depts.map((dept) => {
    const cells: AgingItem[][] = Array.from({ length: DAY_COLS.length }, () => []);
    (deptOrders[dept] || []).forEach((o) => { cells[dayBucketIdx(orderAgeDays(o))].push(o); });
    return { dept, meta: DEPT_META[dept], cells, total: cells.reduce((a, c) => a + c.length, 0) };
  });
}
export function hoursMatrixRows(deptOrders: Record<DeptKey, AgingItem[]>, depts: DeptKey[] = DEPT_ORDER): MatrixRow[] {
  return depts.map((dept) => {
    const cells: AgingItem[][] = Array.from({ length: HOUR_COLS.length }, () => []);
    (deptOrders[dept] || []).forEach((o) => { cells[hourBucketIdx(o.dwell || 0)].push(o); });
    return { dept, meta: DEPT_META[dept], cells, total: cells.reduce((a, c) => a + c.length, 0) };
  });
}

export type DeptColumn = { label: string; list: AgingItem[] };

/** Department Summary's per-column breakdown for one dept — grouped
 *  straight off `deptOrdersMap`'s already-labeled items, so labels here
 *  always match what's shown (and drilled into) everywhere else. */
export function deptColumns(dept: DeptKey, deptOrders: Record<DeptKey, AgingItem[]>): DeptColumn[] {
  const items = deptOrders[dept] || [];
  const labels = dept === "WAREHOUSE" ? WAREHOUSE_SUBSTAGE_LABELS
    : dept === "PACKING_DISPATCH" ? PACKING_DISPATCH_SUBSTAGE_LABELS
    : dept === "QCFAIL" ? Object.values(QCFAIL_BUCKET_LABELS)
    : (REPORT_COLS[dept] || []).map((c) => COL_LABEL[c] || c);
  const byLabel: Record<string, AgingItem[]> = {};
  labels.forEach((l) => { byLabel[l] = []; });
  items.forEach((o) => { if (byLabel[o.statusLabel]) byLabel[o.statusLabel].push(o); });
  return labels.map((l) => ({ label: l, list: byLabel[l] }));
}

export function deptHealth(deptOrders: AgingItem[]) {
  const total = deptOrders.length;
  const crit = deptOrders.filter((o) => (o.dwell || 0) > 3).length;
  const warn = deptOrders.filter((o) => (o.dwell || 0) > 2).length;
  const r = total ? Math.round((crit / total) * 100) : 0;
  let badge: HealthCls = "ok", label = "ON TRACK";
  if (r >= 25) { badge = "critical"; label = "CRITICAL"; }
  else if (r >= 12) { badge = "watch"; label = "WATCH"; }
  return { total, badge, label, okN: total - warn, warnN: warn - crit, critN: crit };
}

export type HeaderKpis = { inProcess: AgingItem[]; crit: AgingItem[]; delay: AgingItem[]; qcHold: AgingItem[] };

/** `deptOrders` must already be scoped to whatever the caller's active
 *  filters are (Lens Type included) — QC hold is derived from it rather
 *  than recomputed from raw stages, so it never drifts out of sync with
 *  the rest of the KPI strip. */
export function headerKpiOrders(deptOrders: Record<DeptKey, AgingItem[]>, depts: DeptKey[]): HeaderKpis {
  const scope = depts.length ? depts : DEPT_ORDER;
  const all = scope.flatMap((d) => deptOrders[d] || []);
  const qcHold = scope.includes("QC")
    ? (deptOrders.QC || []).filter((o) => /HOLD/.test(String(o.status || "").toUpperCase()))
    : [];
  return {
    inProcess: all,
    crit: all.filter((o) => (o.dwell || 0) > 6),
    delay: all.filter((o) => (o.dwell || 0) > 2),
    qcHold,
  };
}

/** The richer, per-component export format — ported from the NJIT Prog
 *  Tracker's engine.js DRILL_COLS, extended with our own Department/JIT/
 *  Tray/Power Type/Fitting ID columns. The one download format used
 *  everywhere in the dashboard: individual drill-downs and the Report
 *  view's consolidated "all orders" dump (order-level XLSX only — no
 *  CSV, no separate item-level file). */
export type ExportRow = {
  Department: string; "Order Type": string; "Increment ID": string; "Shipping Package ID": string; "Fitting ID": string; "Unicom Order Code": string;
  Status: string; "Lens Type": string; "Dwell (Hrs)": number; "Age (Hrs)": number; Channel: string; "Tray No": string; "Power Type": string;
  JIT: string; "JIT Status": string; "Created At": string;
  "Frame PID": string; "Left Lens PID": string; "Right Lens PID": string;
  "Frame Barcode": string; "Left Lens Barcode": string; "Right Lens Barcode": string;
  "Frame Status": string; "Left Lens Status": string; "Right Lens Status": string;
  "Frame Upd (Hrs)": number | ""; "Left Lens Upd (Hrs)": number | ""; "Right Lens Upd (Hrs)": number | "";
};
export function toExportRow(o: AgingItem): ExportRow {
  return {
    Department: DEPT_META[o.dept].name,
    "Order Type": LENS_CLASS_LABEL[o.lensClass],
    "Increment ID": o.incrementId,
    "Shipping Package ID": o.shippingPackageId,
    "Fitting ID": o.fittingId,
    "Unicom Order Code": o.unicom,
    Status: o.statusLabel,
    "Lens Type": o.lensType,
    "Dwell (Hrs)": o.dwell,
    "Age (Hrs)": o.aging,
    Channel: o.channel,
    "Tray No": o.trayNo,
    "Power Type": o.powerType,
    JIT: o.jitFlag ? "Y" : "N",
    "JIT Status": o.jitStatus,
    "Created At": o.createdAt,
    "Frame PID": o.framePid,
    "Left Lens PID": o.leftPid,
    "Right Lens PID": o.rightPid,
    "Frame Barcode": o.frameBarcode,
    "Left Lens Barcode": o.leftBarcode,
    "Right Lens Barcode": o.rightBarcode,
    "Frame Status": o.frameStatus,
    "Left Lens Status": o.leftStatus,
    "Right Lens Status": o.rightStatus,
    "Frame Upd (Hrs)": o.frameUpdHr,
    "Left Lens Upd (Hrs)": o.leftUpdHr,
    "Right Lens Upd (Hrs)": o.rightUpdHr,
  };
}
