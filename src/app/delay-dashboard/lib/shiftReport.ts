// src/app/delay-dashboard/lib/shiftReport.ts
//
// The NDD shift snapshot system — the core mechanic of the original
// "Process Delay Dashboard for OMT2" Chrome extension's report.html/
// report.js (the true "NDD Report", not to be confused with the webapp
// rebuild's simplified card-grid page of the same name). Every refresh
// captures one row for the CURRENT clock hour (same-hour refreshes
// overwrite, they don't accumulate) into an 11-hour, 6:00 PM -> 4:00 AM
// shift ladder, so a shift lead can see exactly which hour a backlog
// built up in. Ported directly from report.js — this file is the piece
// that never made it into the webapp rebuild (its own README lists it
// as deferred), so it's sourced from the extension itself, not from
// business.js.
//
// Snapshots are inherently client-local (one browser, one shift) — same
// as the extension's own localStorage/chrome.storage.local snapshots —
// so this lives entirely in the browser, keyed by facility+jit+frFilter,
// with no server persistence.
//
// The source extension only ever laddered QC/Fitting/MEI (Warehouse,
// QC-Fail, and Packing & Dispatch didn't exist as concepts in it — they
// were introduced later, in this app's own Department Summary). This
// module now ladders all six departments the same way, so every
// Department Summary card has a hover-through hour-by-hour history, not
// just the original three.

import { DEPT_ORDER, type BucketDef, type DeptKey } from "./aggregate";

export type { DeptKey };
export { DEPT_ORDER };

export const SHIFT_HOURS = [17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3];
export const SHIFT_START = 17;

export function shiftCycleKey(h: number): number {
  return (h - SHIFT_START + 24) % 24;
}
export function hourClock(h: number): string {
  h = ((h % 24) + 24) % 24;
  const am = h < 12;
  const hh = h % 12 || 12;
  return `${hh}:00 ${am ? "AM" : "PM"}`;
}
export function isLiveBucket(h: number): boolean {
  return h === new Date().getHours();
}
export function bucketLabel(h: number, live: boolean): string {
  return hourClock(live ? h : h + 1);
}
export function fmtClock(ts: string | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  let hh = d.getHours();
  const am = hh < 12;
  hh = hh % 12 || 12;
  return `${hh}:${String(d.getMinutes()).padStart(2, "0")} ${am ? "AM" : "PM"}`;
}
export function rowLabel(h: number, snap: Snapshot | undefined): string {
  return isLiveBucket(h) ? (fmtClock(snap?.ts) || hourClock(h)) : bucketLabel(h, false);
}
/** Only two phases exist in the source extension — "active" (inside the
 *  6 PM-4 AM window) or "pre" (everything else, including after 4 AM;
 *  the next shift's "pre" IS the previous shift's "post"). */
export function shiftPhase(): "active" | "pre" {
  return SHIFT_HOURS.includes(new Date().getHours()) ? "active" : "pre";
}

export type SnapshotCols = Record<string, [number, number, number, number]>;
export type SnapshotHist = Record<string, Record<number, number>>;
export type Snapshot = {
  ts: string;
  bucket: number;
  cols: SnapshotCols;
  hist: SnapshotHist;
  rowTotal: number;
};
export type StageSnapshots = Record<number, Snapshot>;

export function histAdd(hist: Record<number, number>, dwell: number): void {
  const u = Math.min(Math.ceil(Math.max(0, dwell || 0)), 240);
  hist[u] = (hist[u] || 0) + 1;
}

/** Captures one shift row from the CURRENT live items for one department —
 *  overwrites whatever was already stored for this clock hour. `column`
 *  is whatever the department's own grouping is: a status (QC_HOLD, EDGING,
 *  ...) for QC/Fitting/MEI, a bucket (ASRS, LL, ...) for QC-Fail, or a
 *  sub-stage label (Synced, Packing, ...) for Warehouse/Packing & Dispatch
 *  — the caller maps its own order shape into this common {column, dwell}
 *  form before calling. */
export function captureSnapshot(
  items: { column: string; dwell: number }[],
  columns: string[],
): Snapshot {
  const now = new Date();
  const bucket = now.getHours();
  const snap: Snapshot = { ts: now.toISOString(), bucket, cols: {}, hist: {}, rowTotal: 0 };
  columns.forEach((c) => { snap.cols[c] = [0, 0, 0, 0]; snap.hist[c] = {}; });
  const dwt = [1, 2, 3];
  for (const item of items) {
    if (!columns.includes(item.column)) continue;
    const arr = snap.cols[item.column];
    arr[0]++;
    snap.rowTotal++;
    if (item.dwell > dwt[2]) arr[3]++;
    else if (item.dwell > dwt[1]) arr[2]++;
    else if (item.dwell > dwt[0]) arr[1]++;
    histAdd(snap.hist[item.column], item.dwell);
  }
  return snap;
}

function nextGtEdge(defs: Exclude<BucketDef, null>[], hrs: number): number | null {
  const ups = defs.filter((d) => d.op === ">" && d.hrs > 0).map((d) => d.hrs).filter((h) => h > hrs).sort((a, b) => a - b);
  return ups.length ? ups[0] : null;
}
export function bucketColLabel(def: BucketDef): string {
  if (!def || def.op === "-") return "—";
  if (def.hrs === 0) return "0-1 Hr";
  return def.op === ">" ? `>${def.hrs} Hr` : `<${def.hrs} Hr`;
}
export function activeBuckets(defs: BucketDef[] | undefined): Exclude<BucketDef, null>[] {
  return (defs || []).filter((d): d is Exclude<BucketDef, null> => !!d);
}

/** Exclusive band counts from a frozen snapshot histogram (sealed hour). */
export function bandFromHist(hist: Record<number, number> | undefined, def: BucketDef, defs: Exclude<BucketDef, null>[]): number {
  if (!def || def.op === "-") return 0;
  if (!hist) return 0;
  if (def.op === ">" && def.hrs === 0) return hist[1] || 0;
  let n = 0;
  if (def.op === ">") {
    const edge = nextGtEdge(defs, def.hrs);
    for (const k in hist) { const u = +k; if (u > def.hrs && (edge == null || u <= edge)) n += hist[k]; }
  } else {
    for (const k in hist) { const u = +k; if (u < def.hrs) n += hist[k]; }
  }
  return n;
}
/** Exclusive band counts live, directly from current orders (latest row). */
export function bandFromOrders(orders: { dwell: number }[], def: BucketDef, defs: Exclude<BucketDef, null>[]): number {
  if (!def || def.op === "-") return 0;
  if (def.op === ">" && def.hrs === 0) return orders.filter((o) => Math.ceil(o.dwell || 0) === 1).length;
  if (def.op === ">") {
    const edge = nextGtEdge(defs, def.hrs);
    return orders.filter((o) => { const u = Math.ceil(o.dwell || 0); return u > def.hrs && (edge == null || u <= edge); }).length;
  }
  return orders.filter((o) => Math.ceil(o.dwell || 0) < def.hrs).length;
}

export function getLatestBucket(snaps: StageSnapshots): number | null {
  let latest: number | null = null;
  let latestTs = "";
  Object.entries(snaps).forEach(([b, s]) => {
    if (s.ts > latestTs) { latestTs = s.ts; latest = Number(b); }
  });
  return latest;
}

const STORAGE_PREFIX = "delay-dashboard.shift-snapshots.v1";

export function snapshotStorageKey(facility: string, jit: string, frFilter: string): string {
  return `${STORAGE_PREFIX}.${facility}.${jit}.${frFilter}`;
}

function emptySnapshots(): Record<DeptKey, StageSnapshots> {
  const out = {} as Record<DeptKey, StageSnapshots>;
  DEPT_ORDER.forEach((k) => { out[k] = {}; });
  return out;
}

export function loadAllSnapshots(key: string): Record<DeptKey, StageSnapshots> {
  const empty = emptySnapshots();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    DEPT_ORDER.forEach((k) => {
      if (parsed[k] && typeof parsed[k] === "object") empty[k] = parsed[k];
    });
    return empty;
  } catch {
    return empty;
  }
}
export function saveAllSnapshots(key: string, snapshots: Record<DeptKey, StageSnapshots>): void {
  try { localStorage.setItem(key, JSON.stringify(snapshots)); } catch { /* storage full/unavailable — skip */ }
}

export function fmt(n: number | null | undefined): string {
  return n == null ? "" : Number(n).toLocaleString("en-IN");
}
export function timestamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
}
