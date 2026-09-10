// src/app/delay-dashboard/lib/dispatchAggregate.ts
//
// Client-side presentation math for the Dispatch Report tab — a second
// data set living inside the ONE Delay Dashboard module, beside Report /
// NDD Shift Report / PID Vault. Ported from the "Dispatch Pendency
// Tracker" extension's dispatch.js — same bucket/band/matrix/health math
// as this module's own lib/aggregate.ts, kept in a separate file (not
// merged into it) because the two data models are genuinely different
// (six dispatch categories × three stages vs. six delay departments) and
// several symbol names would otherwise collide (DeptKey, StageKey,
// DEPT_META, BucketDef, …) — consumers that need both import this file
// as a namespace (`import * as Dispatch from "./lib/dispatchAggregate"`).

import type { DispatchCategoriesData, DispatchOrder, DispatchOrderItem } from "../types";

export type DeptKey = "FR1" | "FR2" | "FR0" | "FR0BULK" | "CLBULK" | "CL";
export type StageKey = "PACKING" | "MANIFEST" | "RTS";
export type HealthCls = "ok" | "watch" | "alert" | "critical";

export const DEPT_META: Record<DeptKey, { name: string; sub: string; ico: string; stages: StageKey[] }> = {
  FR1: { name: "FR1", sub: "Prescription Eyewear", ico: "👓", stages: ["PACKING", "MANIFEST", "RTS"] },
  FR2: { name: "FR2", sub: "JIT / Reglaze", ico: "🔁", stages: ["PACKING", "MANIFEST", "RTS"] },
  FR0: { name: "FR0", sub: "Frame / Sunglass — Non-Bulk", ico: "🕶", stages: ["PACKING", "MANIFEST", "RTS"] },
  FR0BULK: { name: "FR0-BULK", sub: "Frame / Sunglass / Accessories — Bulk", ico: "📦", stages: ["MANIFEST", "RTS"] },
  CLBULK: { name: "CL/CLS-BULK", sub: "Contact Lens / Solution — Bulk", ico: "💧", stages: ["MANIFEST", "RTS"] },
  CL: { name: "CL/CLS", sub: "Contact Lens / Solution", ico: "👁", stages: ["MANIFEST", "RTS"] },
};
export const DEPT_ORDER: DeptKey[] = ["FR1", "FR2", "FR0", "FR0BULK", "CLBULK", "CL"];

export const STAGE_META: Record<StageKey, { label: string; ico: string }> = {
  PACKING: { label: "Packing", ico: "📦" },
  MANIFEST: { label: "Manifest", ico: "🗂" },
  RTS: { label: "Ready To Ship", ico: "🚚" },
};
export const STAGE_ORDER: StageKey[] = ["PACKING", "MANIFEST", "RTS"];

export function catsForStage(stage: StageKey): DeptKey[] {
  return DEPT_ORDER.filter((d) => DEPT_META[d].stages.includes(stage));
}

/** The canonical drillable order shape — every Dispatch Summary cell,
 *  aging-matrix cell, and KPI number is ultimately a filtered list of
 *  these. */
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

export function stageItems(categories: DispatchCategoriesData, dept: DeptKey, stage: StageKey): PendencyItem[] {
  const entry = categories[dept]?.[stage];
  return entry ? entry.orders.map((o) => toPendencyItem(dept, stage, o)) : [];
}
export function deptAllItems(categories: DispatchCategoriesData, dept: DeptKey): PendencyItem[] {
  return DEPT_META[dept].stages.flatMap((s) => stageItems(categories, dept, s));
}
export function allItemsInStage(categories: DispatchCategoriesData, stage: StageKey): PendencyItem[] {
  return catsForStage(stage).flatMap((d) => stageItems(categories, d, stage));
}
export function allItems(categories: DispatchCategoriesData): PendencyItem[] {
  return DEPT_ORDER.flatMap((d) => deptAllItems(categories, d));
}

/* ── Hour buckets — PER STAGE (shared across every category that runs
   it), matching the source extension's model, not per-department like
   this module's own Report/NDD Shift Report buckets. */
export type BucketDef = { op: ">" | "<" | "-"; hrs: number } | null;

export const DEFAULT_BUCKETS: Record<StageKey, BucketDef[]> = {
  PACKING: [{ op: ">", hrs: 1 }, { op: ">", hrs: 2 }, { op: ">", hrs: 4 }],
  MANIFEST: [{ op: ">", hrs: 1 }, { op: ">", hrs: 2 }, { op: ">", hrs: 4 }],
  RTS: [{ op: ">", hrs: 1 }, { op: ">", hrs: 2 }, { op: ">", hrs: 4 }],
};

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

/* ── Aging matrices (Days / Hours) ───────────────────────────────── */
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

/** Both aging matrices share one stage scope: "ALL" (combine every
 *  stage the category runs) or one specific stage — a category that
 *  doesn't run it (e.g. FR0-BULK under Packing) correctly shows an
 *  all-zero row rather than disappearing, so the row set stays the
 *  same six categories regardless of filter. */
export type AgingStageFilter = "ALL" | StageKey;
export function agingRowItems(categories: DispatchCategoriesData, dept: DeptKey, stageFilter: AgingStageFilter): PendencyItem[] {
  return stageFilter === "ALL" ? deptAllItems(categories, dept) : stageItems(categories, dept, stageFilter);
}

export type MatrixRow = { dept: DeptKey; meta: { name: string; ico: string }; cells: PendencyItem[][]; total: number };
export function daysMatrixRows(categories: DispatchCategoriesData, stageFilter: AgingStageFilter, depts: DeptKey[] = DEPT_ORDER): MatrixRow[] {
  return depts.map((dept) => {
    const cells: PendencyItem[][] = Array.from({ length: DAY_COLS.length }, () => []);
    agingRowItems(categories, dept, stageFilter).forEach((o) => { cells[dayBucketIdx(orderAgeDays(o))].push(o); });
    return { dept, meta: DEPT_META[dept], cells, total: cells.reduce((a, c) => a + c.length, 0) };
  });
}
export function hoursMatrixRows(categories: DispatchCategoriesData, stageFilter: AgingStageFilter, depts: DeptKey[] = DEPT_ORDER): MatrixRow[] {
  return depts.map((dept) => {
    const cells: PendencyItem[][] = Array.from({ length: HOUR_COLS.length }, () => []);
    agingRowItems(categories, dept, stageFilter).forEach((o) => { cells[hourBucketIdx(o.dwell || 0)].push(o); });
    return { dept, meta: DEPT_META[dept], cells, total: cells.reduce((a, c) => a + c.length, 0) };
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

/* ── Mini-columns (dual axis: dept-card→stage-columns for Individual
   view, stage-card→dept-columns for Board view) ─────────────────── */
export type MiniCol = { key: string; label: string; list: PendencyItem[] };
export function deptStageColumns(categories: DispatchCategoriesData, dept: DeptKey): MiniCol[] {
  return DEPT_META[dept].stages.map((s) => ({ key: s, label: STAGE_META[s].label, list: stageItems(categories, dept, s) }));
}
export function stageDeptColumns(categories: DispatchCategoriesData, stage: StageKey): MiniCol[] {
  return catsForStage(stage).map((d) => ({ key: d, label: DEPT_META[d].name, list: stageItems(categories, d, stage) }));
}

/* ── KPIs ─────────────────────────────────────────────────────────── */
export type HeaderKpis = { inProcess: PendencyItem[]; crit: PendencyItem[]; atRts: PendencyItem[]; delay: PendencyItem[] };
export function headerKpiItems(categories: DispatchCategoriesData): HeaderKpis {
  const all = allItems(categories);
  return {
    inProcess: all,
    crit: all.filter((o) => (o.dwell || 0) > 6),
    atRts: allItemsInStage(categories, "RTS"),
    delay: all.filter((o) => (o.dwell || 0) > 2),
  };
}

/* ── Export ───────────────────────────────────────────────────────── */
export type ExportRow = {
  Category: string; Stage: string; "Increment ID": string; "Shipping Package ID": string; "Fitting ID": string; "Unicom Order Code": string;
  Status: string; JIT: string; "Age (Hrs)": number; "Dwell (Hrs)": number; Channel: string; "Tray No": string;
  "Manifest No": string; "AWB No": string; "Courier Code": string; Items: number; "Created At": string;
};
export function toExportRow(o: PendencyItem): ExportRow {
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
    "Created At": o.createdAt,
  };
}
