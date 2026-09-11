// Server-side persistence for the NDD Shift Report — the same hourly
// snapshot the browser captures into localStorage (see
// src/app/delay-dashboard/lib/shiftReport.ts), but triggered on a fixed
// schedule and written to `mydb` so it survives across browsers/shifts.
// Reuses the delay-dashboard route's own POST handler (and therefore its
// existing cache + upstream auth) rather than re-fetching NexS directly.

import { POST as delayDashboardPost } from "@/app/api/delay-dashboard/route";
import { deptOrdersMap, DEPT_ORDER } from "@/app/delay-dashboard/lib/aggregate";
import { captureSnapshot, DEPT_CONFIG } from "@/app/delay-dashboard/lib/shiftReport";
import { buildPidSets } from "@/app/delay-dashboard/lib/pidClassify";
import type { PipelineData, QcfailData, ReportData } from "@/app/delay-dashboard/types";
import prisma from "@/utils/prisma";

const FACILITIES = ["NXS1", "NXS2"] as const;
// lensClass isn't used by the snapshot (only status/dwell are), so an empty
// PID Vault is fine here — see classifyLensPids, which never throws.
const EMPTY_PID_SETS = buildPidSets([], []);

function istParts(date = new Date()): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

async function callDelayDashboard<T>(body: Record<string, unknown>): Promise<T> {
  const response = await delayDashboardPost(new Request("http://internal.ndd-shift-log/api/delay-dashboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  const payload = await response.json() as { ok: boolean; data?: T; error?: string };
  if (!payload.ok || payload.data === undefined) throw new Error(payload.error || "delay-dashboard request failed.");
  return payload.data;
}

/** Mirrors the Delay Dashboard's own default filter state (facility aside)
 *  — see src/app/delay-dashboard/page.tsx's initial useState values — so
 *  the logged snapshot matches what a shift lead sees on a fresh page load. */
async function captureFacility(facility: typeof FACILITIES[number], day: string, hour: number): Promise<void> {
  const base = { facility, nddOnly: true, jit: "all", frFilter: "all", international: "all" };
  const [report, qcfail, warehouse, packingDispatch] = await Promise.all([
    callDelayDashboard<ReportData>({ action: "report", ...base, frameFilter: "all" }),
    callDelayDashboard<QcfailData>({ action: "qcfail", ...base }),
    callDelayDashboard<PipelineData>({ action: "warehouse", ...base }),
    callDelayDashboard<PipelineData>({ action: "packingDispatch", ...base }),
  ]);

  const deptOrders = deptOrdersMap(report.stages, qcfail.orders, warehouse.orders, packingDispatch.orders, EMPTY_PID_SETS);
  const dayDate = new Date(`${day}T00:00:00.000Z`);

  await Promise.all(DEPT_ORDER.map(async (dept) => {
    const items = deptOrders[dept].map((o) => ({ column: o.status, dwell: o.dwell }));
    const snap = captureSnapshot(items, DEPT_CONFIG[dept].columns, hour);
    await prisma.nddShiftLog.upsert({
      where: { day_hour_facility_dept: { day: dayDate, hour, facility, dept } },
      create: { day: dayDate, hour, facility, dept, cols: snap.cols, hist: snap.hist, rowTotal: snap.rowTotal },
      update: { cols: snap.cols, hist: snap.hist, rowTotal: snap.rowTotal, capturedAt: new Date() },
    });
  }));
}

export async function captureNddShiftSnapshot(): Promise<void> {
  const { day, hour } = istParts();
  const results = await Promise.allSettled(FACILITIES.map((facility) => captureFacility(facility, day, hour)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`[ndd-shift-log] Capture failed for ${FACILITIES[index]}.`, result.reason);
    }
  });
}

declare global {
  var __nddShiftLogTimer: ReturnType<typeof setInterval> | undefined;
  var __nddShiftLogLastKey: string | null | undefined;
}

/** Polls every 20s rather than scheduling one long setTimeout to the next
 *  :58 — simpler, immune to timer drift over a long-running process, and
 *  safe to call repeatedly (the day+hour+facility+dept unique key makes
 *  capture idempotent, and the lastKey guard avoids redundant upstream
 *  fetches within the same target minute). */
export function startNddShiftLogScheduler(): void {
  if (globalThis.__nddShiftLogTimer) return;
  globalThis.__nddShiftLogLastKey ??= null;

  const tick = () => {
    const now = new Date();
    const minute = Number(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      minute: "2-digit",
    }).format(now));
    if (minute !== 58) return;

    const { day, hour } = istParts(now);
    const key = `${day}T${hour}`;
    if (key === globalThis.__nddShiftLogLastKey) return;
    globalThis.__nddShiftLogLastKey = key;

    void captureNddShiftSnapshot().catch((error: unknown) => {
      console.error("[ndd-shift-log] Scheduled capture failed.", error);
    });
  };

  globalThis.__nddShiftLogTimer = setInterval(tick, 20_000);
  tick();
}
