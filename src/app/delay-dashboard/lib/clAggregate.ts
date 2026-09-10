// src/app/delay-dashboard/lib/clAggregate.ts
//
// Client-side presentation math for the CL Report tab. Unlike Dispatch
// Report (six categories, each its own card, stages as inner columns),
// CL-FR0 / Bulk (CL/CLS) here are a narrowing FILTER — like Delay
// Report's own FR1/FR2 filter — not a second card axis. The STAGE
// (Synced, Pending Picking, In Picking, Order QC, Packing, Manifest,
// Shipment Not Generated, plus CL-FR0's two QC-Fail rework sub-buckets)
// is the report's primary axis: one row per stage in both aging
// matrices, one card per stage in the summary panel, with whichever
// categories run that stage (and pass the CL-FR0/Bulk filter) as that
// card's inner columns. Ready To Ship is intentionally not tracked —
// explicit correction, this report stops at Manifest.

import type { DispatchCategoriesData, DispatchOrder, DispatchOrderItem } from "../types";

export type DeptKey = "CL" | "BULK";
export type StageKey =
  | "SYNCED" | "PENDING_PICKING" | "IN_PICKING" | "ORDER_QC" | "PACKING" | "MANIFEST"
  | "SHIPMENT_NOT_GENERATED" | "QC_FAIL_PENDING_PICKING" | "QC_FAIL_IN_PICKING";
export type HealthCls = "ok" | "watch" | "alert" | "critical";
export type ViewMode = "shipment" | "order";
/** The CL-FR0 / Bulk filter — narrows every count in the report, same
 *  role as Delay Report's FR Tag filter. "all" combines both. */
export type TagFilter = "all" | DeptKey;

const CORE_STAGES: StageKey[] = ["SYNCED", "PENDING_PICKING", "IN_PICKING", "ORDER_QC", "PACKING", "MANIFEST", "SHIPMENT_NOT_GENERATED"];

export const DEPT_META: Record<DeptKey, { name: string; sub: string; ico: string; stages: StageKey[] }> = {
  CL: { name: "CL-FR0", sub: "Contact Lens / Solution", ico: "👁", stages: [...CORE_STAGES, "QC_FAIL_PENDING_PICKING", "QC_FAIL_IN_PICKING"] },
  BULK: { name: "Bulk (CL/CLS)", sub: "Contact Lens / Solution — Bulk", ico: "📦", stages: CORE_STAGES },
};
export const DEPT_ORDER: DeptKey[] = ["CL", "BULK"];

export const STAGE_META: Record<StageKey, { label: string; ico: string }> = {
  SYNCED: { label: "Synced", ico: "🔄" },
  PENDING_PICKING: { label: "Pending Picking", ico: "🕒" },
  IN_PICKING: { label: "In Picking", ico: "🧺" },
  ORDER_QC: { label: "Order QC", ico: "🔍" },
  PACKING: { label: "Packing", ico: "📦" },
  MANIFEST: { label: "Manifest", ico: "🗂" },
  SHIPMENT_NOT_GENERATED: { label: "Shipment Not Generated", ico: "⚠" },
  QC_FAIL_PENDING_PICKING: { label: "QC Fail · Pending Picking", ico: "⛔" },
  QC_FAIL_IN_PICKING: { label: "QC Fail · In Picking", ico: "⛔" },
};
export const STAGE_ORDER: StageKey[] = [...CORE_STAGES, "QC_FAIL_PENDING_PICKING", "QC_FAIL_IN_PICKING"];

export function catsForStage(stage: StageKey): DeptKey[] {
  return DEPT_ORDER.filter((d) => DEPT_META[d].stages.includes(stage));
}
/** catsForStage(), narrowed further by the active CL-FR0/Bulk filter. */
function tagScopedCats(stage: StageKey, tagFilter: TagFilter): DeptKey[] {
  const cats = catsForStage(stage);
  return tagFilter === "all" ? cats : cats.filter((d) => d === tagFilter);
}

/** The canonical drillable order shape — every CL Summary cell,
 *  aging-matrix cell, and KPI number is ultimately a filtered list of
 *  these. In "order" view mode, one PendencyItem = one shipment (its
 *  `items` array holds every item on that shipment, matching how every
 *  other view in this app already counts). In "shipment" view mode
 *  (Bulk only — see explodeToItemLevel), one PendencyItem = one single
 *  item/unit — `items` always has exactly one entry, and `dwell` is
 *  that item's own last-update, not the shipment's. */
export type PendencyItem = {
  dept: DeptKey;
  stage: StageKey;
  incrementId: string;
  shippingPackageId: string;
  fittingId: string;
  unicom: string;
  status: string;
  channel: string;
  trayNo: string;
  manifestNo: string;
  awbNo: string;
  courierCode: string;
  jitFlag: boolean;
  dwell: number;
  aging: number;
  createdAt: string;
  items: DispatchOrderItem[];
};

function toPendencyItem(dept: DeptKey, stage: StageKey, o: DispatchOrder): PendencyItem {
  return {
    dept, stage,
    incrementId: o.incrementId, shippingPackageId: o.shippingPackageId, fittingId: o.fittingId,
    unicom: o.unicom, status: o.status, channel: o.channel, trayNo: o.trayNo,
    manifestNo: o.manifestNo, awbNo: o.awbNo, courierCode: o.courierCode,
    jitFlag: o.jitFlag, dwell: o.dwell || 0, aging: o.aging || 0, createdAt: o.createdAt || "",
    items: o.items || [],
  };
}

/** "Shipment wise" = every individual item/unit counted separately —
 *  matches what NexS's own monitor panel shows (e.g. a Bulk order with
 *  200 contact lens boxes under one Shipping Package ID shows as 200
 *  here, not 1). Confirmed against a live capture: "Bulk : Pending
 *  Picking" showed "Showing 35/119084" in NexS's own panel — that
 *  119,084 is a per-item count, not the ~13,452 distinct shipments
 *  behind it. Each exploded row keeps the shipment's identity fields
 *  but takes the item's own last-update as its dwell (age-bucketing
 *  should reflect that specific item, not the shipment's slowest one). */
export function explodeToItemLevel(list: PendencyItem[]): PendencyItem[] {
  const out: PendencyItem[] = [];
  for (const o of list) {
    if (!o.items.length) { out.push(o); continue; }
    for (const it of o.items) {
      out.push({ ...o, dwell: it.lastUpdate || 0, items: [it] });
    }
  }
  return out;
}
/** Only Bulk explodes to item-level — CL-FR0 orders are small (a pair
 *  of lenses) and this toggle was scoped to Bulk from the start. */
function viewScoped(list: PendencyItem[], dept: DeptKey, viewMode: ViewMode): PendencyItem[] {
  return dept === "BULK" && viewMode === "shipment" ? explodeToItemLevel(list) : list;
}

/** One (category, stage) list — the base accessor everything else
 *  composes from. */
export function stageItems(categories: DispatchCategoriesData, dept: DeptKey, stage: StageKey, viewMode: ViewMode = "order"): PendencyItem[] {
  const entry = categories[dept]?.[stage];
  const list = entry ? entry.orders.map((o) => toPendencyItem(dept, stage, o)) : [];
  return viewScoped(list, dept, viewMode);
}
/** Every item for one stage, across whichever categories run it and
 *  pass the CL-FR0/Bulk filter — the primary row accessor for the
 *  aging matrices and the summary panel's stage cards. */
export function stageAllItems(categories: DispatchCategoriesData, stage: StageKey, tagFilter: TagFilter, viewMode: ViewMode = "order"): PendencyItem[] {
  return tagScopedCats(stage, tagFilter).flatMap((d) => stageItems(categories, d, stage, viewMode));
}
export function allItems(categories: DispatchCategoriesData, tagFilter: TagFilter, viewMode: ViewMode = "order"): PendencyItem[] {
  return STAGE_ORDER.flatMap((s) => stageAllItems(categories, s, tagFilter, viewMode));
}

/* ── Hour buckets — per stage, shared across whichever category runs
   it (same model as Dispatch Report's). */
export type BucketDef = { op: ">" | "<" | "-"; hrs: number } | null;

export const DEFAULT_BUCKETS: Record<StageKey, BucketDef[]> = STAGE_ORDER.reduce((acc, stage) => {
  acc[stage] = [{ op: ">", hrs: 1 }, { op: ">", hrs: 2 }, { op: ">", hrs: 4 }];
  return acc;
}, {} as Record<StageKey, BucketDef[]>);

function nextGtEdge(defs: Exclude<BucketDef, null>[], hrs: number): number | null {
  const ups = defs.filter((d) => d.op === ">" && d.hrs > 0).map((d) => d.hrs).filter((h) => h > hrs).sort((a, b) => a - b);
  return ups.length ? ups[0] : null;
}
export function bandHdrLabel(b: BucketDef): string {
  return !b || b.op === "-" ? "—" : b.hrs === 0 ? "0-1HR" : `${b.op === "<" ? "<" : ">"}${b.hrs}HR`;
}
export type Band = { def: Exclude<BucketDef, null>; list: PendencyItem[] };
export function bandBuckets(list: PendencyItem[], stageBuckets: BucketDef[]): (Band | null)[] {
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

/* ── Aging matrices (Days / Hours) — one row per STAGE ───────────── */
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
export function orderAgeDays(o: PendencyItem): number {
  let ms = utcMs(o.createdAt);
  if (!Number.isFinite(ms) && Number.isFinite(o.aging) && o.aging > 0) ms = Date.now() - o.aging * 3_600_000;
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, istDayIndex(Date.now()) - istDayIndex(ms));
}

export type MatrixRow = { stage: StageKey; meta: { label: string; ico: string }; cells: PendencyItem[][]; total: number };
export function daysMatrixRows(categories: DispatchCategoriesData, tagFilter: TagFilter, viewMode: ViewMode = "order", stages: StageKey[] = STAGE_ORDER): MatrixRow[] {
  return stages.map((stage) => {
    const cells: PendencyItem[][] = Array.from({ length: DAY_COLS.length }, () => []);
    stageAllItems(categories, stage, tagFilter, viewMode).forEach((o) => { cells[dayBucketIdx(orderAgeDays(o))].push(o); });
    return { stage, meta: STAGE_META[stage], cells, total: cells.reduce((a, c) => a + c.length, 0) };
  });
}
export function hoursMatrixRows(categories: DispatchCategoriesData, tagFilter: TagFilter, viewMode: ViewMode = "order", stages: StageKey[] = STAGE_ORDER): MatrixRow[] {
  return stages.map((stage) => {
    const cells: PendencyItem[][] = Array.from({ length: HOUR_COLS.length }, () => []);
    stageAllItems(categories, stage, tagFilter, viewMode).forEach((o) => { cells[hourBucketIdx(o.dwell || 0)].push(o); });
    return { stage, meta: STAGE_META[stage], cells, total: cells.reduce((a, c) => a + c.length, 0) };
  });
}

/* ── Health / RAG ─────────────────────────────────────────────────── */
export function healthFor(list: PendencyItem[]) {
  const total = list.length;
  const crit = list.filter((o) => (o.dwell || 0) > 3).length;
  const warn = list.filter((o) => (o.dwell || 0) > 2).length;
  const r = total ? Math.round((crit / total) * 100) : 0;
  let badge: HealthCls = "ok", label = "ON TRACK";
  if (r >= 25) { badge = "critical"; label = "CRITICAL"; }
  else if (r >= 12) { badge = "watch"; label = "WATCH"; }
  return { total, badge, label, okN: total - warn, warnN: warn - crit, critN: crit };
}

/* ── Mini-columns — inner columns of each stage card, one per category
   that runs the stage and passes the CL-FR0/Bulk filter. ─────────── */
export type MiniCol = { key: DeptKey; label: string; list: PendencyItem[] };
export function stageDeptColumns(categories: DispatchCategoriesData, stage: StageKey, tagFilter: TagFilter, viewMode: ViewMode = "order"): MiniCol[] {
  return tagScopedCats(stage, tagFilter).map((d) => ({ key: d, label: DEPT_META[d].name, list: stageItems(categories, d, stage, viewMode) }));
}

/* ── KPIs ─────────────────────────────────────────────────────────── */
export type HeaderKpis = { inProcess: PendencyItem[]; crit: PendencyItem[]; atManifest: PendencyItem[]; delay: PendencyItem[] };
export function headerKpiItems(categories: DispatchCategoriesData, tagFilter: TagFilter, viewMode: ViewMode = "order"): HeaderKpis {
  const all = allItems(categories, tagFilter, viewMode);
  return {
    inProcess: all,
    crit: all.filter((o) => (o.dwell || 0) > 6),
    atManifest: stageAllItems(categories, "MANIFEST", tagFilter, viewMode),
    delay: all.filter((o) => (o.dwell || 0) > 2),
  };
}

/* ── Export ───────────────────────────────────────────────────────── */
export type ExportRow = {
  Category: string; Stage: string; "Increment ID": string; "Shipping Package ID": string; "Fitting ID": string; "Unicom Order Code": string;
  Status: string; JIT: string; "Age (Hrs)": number; "Dwell (Hrs)": number; Channel: string; "Tray No": string;
  "Manifest No": string; "AWB No": string; "Courier Code": string; Items: number;
  "Item Type": string; Barcode: string; "Product ID": string; "Created At": string;
};
/** In "shipment" (item-level) view mode `items` always has exactly one
 *  entry, so Item Type/Barcode/Product ID are that item's own. In
 *  "order" mode they're the shipment's first item — a representative
 *  sample, not exhaustive (see `Items` for the true count on that row). */
export function toExportRow(o: PendencyItem): ExportRow {
  const first = o.items[0];
  return {
    Category: DEPT_META[o.dept].name,
    Stage: STAGE_META[o.stage].label,
    "Increment ID": o.incrementId,
    "Shipping Package ID": o.shippingPackageId,
    "Fitting ID": o.fittingId,
    "Unicom Order Code": o.unicom,
    Status: o.status,
    JIT: o.jitFlag ? "Y" : "N",
    "Age (Hrs)": o.aging,
    "Dwell (Hrs)": o.dwell,
    Channel: o.channel,
    "Tray No": o.trayNo,
    "Manifest No": o.manifestNo,
    "AWB No": o.awbNo,
    "Courier Code": o.courierCode,
    Items: o.items.length,
    "Item Type": first?.itemType || "",
    Barcode: first?.barcode || "",
    "Product ID": first?.productId || "",
    "Created At": o.createdAt,
  };
}
