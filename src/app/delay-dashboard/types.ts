// src/app/delay-dashboard/types.ts
//
// Shared client-side types for the ONE Delay Dashboard page and its view
// components. Local to this single module.

import * as XLSX from "xlsx";

export type Facility = "NXS1" | "NXS2";
export type StageKey = "QC" | "FITTING" | "MEI";
export type Jit = "all" | "jit" | "nonjit";
export type FrFilter = "all" | "FR1" | "FR2";
export type FrameFilter = "all" | "fullrim" | "halfrim" | "rimless";
export type International = "all" | "intl" | "nonintl";
export type DateMode = "allPeriod" | "today" | "last7" | "last20" | "custom";
export type HealthCls = "ok" | "watch" | "alert" | "critical";
export type Health = { cls: HealthCls; label: string };
export type View = "report" | "shiftReport" | "pidMasters" | "dispatch" | "cl" | "drilldown" | "dispatchDrilldown" | "clDrilldown";

/** One frame/lens row within an order — carried through from the server
 *  (see src/lib/server/delay-dashboard.ts's OrderItem) so the client can
 *  classify Stock Progressive vs. Single Vision from lens Product IDs and
 *  build the per-component (Frame/Left Lens/Right Lens) export columns. */
export type OrderItem = {
  itemType: string;
  status: string;
  barcode: string;
  productId: string;
  lensType: string;
  lastUpdate: number;
};

export type StageOrder = {
  shippingPackageId: string;
  incrementId: string;
  fittingId: string;
  unicom: string;
  status: string;
  channel: string;
  lensType: string;
  trayNo: string;
  powerType: string;
  jitStatus: string;
  jitFlag: boolean;
  dwell: number;
  aging: number;
  createdAt: string;
  items: OrderItem[];
};

export type StageStats = { total: number; g1: number; g2: number; g3: number; holds: number; health: Health };
export type StagesData = Record<StageKey, { stats: StageStats; orders: StageOrder[] }>;

export type QcfailOrder = {
  shippingPackageId: string;
  incrementId: string;
  fittingId: string;
  unicom: string;
  bucket: string | null;
  subLabel: string;
  decidedStatus: string;
  curStatus: string;
  channel: string;
  trayNo: string;
  lensType: string;
  powerType: string;
  jit: string;
  jitFlag: boolean;
  dwell: number;
  aging: number;
  createdAt: string;
  items: OrderItem[];
};

export type TaggedOrder = {
  shippingPackageId: string;
  incrementId: string;
  fittingId: string;
  unicom: string;
  subLabel: string;
  curStatus: string;
  channel: string;
  trayNo: string;
  lensType: string;
  powerType: string;
  jit: string;
  jitFlag: boolean;
  dwell: number;
  aging: number;
  createdAt: string;
  items: OrderItem[];
};

export type PipelineStats = { total: number; g1: number; g2: number; g3: number; holds: number; health: Health };

export type ReportData = { fetchedAt: string; stages: StagesData };
export type QcfailData = { fetchedAt: string; orders: QcfailOrder[] };
export type PipelineData = { fetchedAt: string; stats: PipelineStats; orders: TaggedOrder[] };

/** Dispatch Report tab — a second, unrelated data set (Packing / Manifest
 *  / Ready To Ship across six dispatch categories) living inside this
 *  same module, ported from the "Dispatch Pendency Tracker" extension.
 *  Kept as its own distinctly-named types (not reusing OrderItem/
 *  StageOrder above) since the shapes genuinely differ — see
 *  src/lib/server/dispatch-report.ts and ./lib/dispatchAggregate.ts. */
export type DispatchOrderItem = {
  orderItemId: string;
  itemType: string;
  status: string;
  barcode: string;
  productId: string;
  lastUpdate: number;
};
export type DispatchOrder = {
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
  items: DispatchOrderItem[];
};
/** categories[dept][stage] — the same shape the dispatch API returns,
 *  one entry per (category, stage) pair the category actually runs. */
export type DispatchCategoriesData = Record<string, Record<string, { orders: DispatchOrder[]; total: number }>>;
export type DispatchReportData = { fetchedAt: string; categories: DispatchCategoriesData };

export const MAX_PAST_DAYS = 20;

export function todayYmd(): string { return new Date().toISOString().slice(0, 10); }
export function addDays(ymd: string, n: number): string { const d = new Date(`${ymd}T00:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
export function dateBounds() { return { min: addDays(todayYmd(), -MAX_PAST_DAYS), max: todayYmd() }; }
export function dateRangeFor(mode: DateMode, startDate: string, endDate: string, startTime: string, endTime: string) {
  if (mode === "allPeriod") return undefined;
  const today = todayYmd();
  if (mode === "today") return { startValue: `${today} 00:00:00`, endValue: `${today} 23:59:59` };
  if (mode === "last7") return { startValue: `${addDays(today, -6)} 00:00:00`, endValue: `${today} 23:59:59` };
  if (mode === "last20") return { startValue: `${addDays(today, -MAX_PAST_DAYS)} 00:00:00`, endValue: `${today} 23:59:59` };
  if (!startDate) return undefined;
  const end = endDate || startDate;
  return { startValue: `${startDate} ${startTime}:00`, endValue: `${end} ${endTime}:00` };
}
export function fmtHours(h: number): string { return Number(h || 0).toFixed(1); }
export function dwellClass(h: number): string { return h > 3 ? "rose" : h > 1 ? "amber" : ""; }
export function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
export function timestamp(): string { return new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-"); }

export function downloadCsvRows(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.map(csvCell).join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function downloadTextFile(text: string, filename: string, mimeType = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["﻿", text], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function downloadXlsxRows(rows: Record<string, unknown>[], filename: string, sheetName: string) {
  if (!rows.length) return;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), sheetName);
  XLSX.writeFile(workbook, filename, { compression: true });
}
