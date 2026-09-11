"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, Gauge, Globe, Glasses, Layers, RefreshCw, Repeat, Settings, Tag, Timer, Zap } from "lucide-react";

import ReportView from "./components/ReportView";
import ShiftReportView from "./components/ShiftReportView";
import PidMastersView from "./components/PidMastersView";
import DrilldownView from "./components/DrilldownView";
import DispatchReportView from "./components/DispatchReportView";
import DispatchDrilldownView from "./components/DispatchDrilldownView";
import ClReportView from "./components/ClReportView";
import ClDrilldownView from "./components/ClDrilldownView";
import { DEFAULT_BUCKETS, DEPT_META, DEPT_ORDER, type AgingItem, type BucketDef, type DeptKey } from "./lib/aggregate";
import * as Dispatch from "./lib/dispatchAggregate";
import * as ClR from "./lib/clAggregate";
import { buildPidSets, type LensTypeFilter, type PidSets } from "./lib/pidClassify";
import {
  dateBounds,
  dateRangeFor,
  fmtTime,
  type DateMode,
  type DispatchReportData,
  type Facility,
  type FrFilter,
  type FrameFilter,
  type International,
  type Jit,
  type PipelineData,
  type QcfailData,
  type ReportData,
  type View,
} from "./types";

const BUCKETS_STORAGE_KEY = "delay-dashboard.buckets.v1";
const SHIFT_BUCKETS_STORAGE_KEY = "delay-dashboard.shiftBuckets.v1";
const DEPT_VIEW_STORAGE_KEY = "delay-dashboard.deptView.v1";
const DISPATCH_BUCKETS_STORAGE_KEY = "delay-dashboard.dispatchBuckets.v1";
const DISPATCH_DEPT_VIEW_STORAGE_KEY = "delay-dashboard.dispatchDeptView.v1";
const CL_BUCKETS_STORAGE_KEY = "delay-dashboard.clBuckets.v1";
const CL_VIEW_MODE_STORAGE_KEY = "delay-dashboard.clViewMode.v1";
const EMPTY_PID_SETS: PidSets = { cyl: new Set(), noncyl: new Set() };

const NAV: { view: View; label: string }[] = [
  { view: "report", label: "Report" },
  { view: "shiftReport", label: "NDD Shift Report" },
  { view: "dispatch", label: "Dispatch Report" },
  { view: "cl", label: "CL Report" },
  { view: "pidMasters", label: "PID Vault" },
];

/** The NDD Shift Report is always P1-only, locked — matching the source
 *  extension's report.html (its own nddOnly is hardcoded true, no toggle). */
const NDD_ONLY_LOCKED_VIEWS: View[] = ["shiftReport"];

function loadBucketsFrom(storageKey: string): Record<DeptKey, BucketDef[]> {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
    const out = {} as Record<DeptKey, BucketDef[]>;
    DEPT_ORDER.forEach((dept) => { out[dept] = Array.isArray(saved[dept]) ? saved[dept] : DEFAULT_BUCKETS[dept]; });
    return out;
  } catch {
    return DEFAULT_BUCKETS;
  }
}
function loadDeptView(): DeptKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DEPT_VIEW_STORAGE_KEY) || "null");
    if (Array.isArray(raw) && raw.length) return DEPT_ORDER.filter((d) => raw.includes(d));
  } catch { /* ignore */ }
  return [...DEPT_ORDER];
}
function loadDispatchBuckets(): Record<Dispatch.StageKey, Dispatch.BucketDef[]> {
  try {
    const saved = JSON.parse(localStorage.getItem(DISPATCH_BUCKETS_STORAGE_KEY) || "{}");
    const out = {} as Record<Dispatch.StageKey, Dispatch.BucketDef[]>;
    Dispatch.STAGE_ORDER.forEach((stage) => { out[stage] = Array.isArray(saved[stage]) ? saved[stage] : Dispatch.DEFAULT_BUCKETS[stage]; });
    return out;
  } catch {
    return Dispatch.DEFAULT_BUCKETS;
  }
}
function loadDispatchDeptView(): Dispatch.DeptKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISPATCH_DEPT_VIEW_STORAGE_KEY) || "null");
    if (Array.isArray(raw) && raw.length) return Dispatch.DEPT_ORDER.filter((d) => raw.includes(d));
  } catch { /* ignore */ }
  return [...Dispatch.DEPT_ORDER];
}
function loadClBuckets(): Record<ClR.StageKey, ClR.BucketDef[]> {
  try {
    const saved = JSON.parse(localStorage.getItem(CL_BUCKETS_STORAGE_KEY) || "{}");
    const out = {} as Record<ClR.StageKey, ClR.BucketDef[]>;
    ClR.STAGE_ORDER.forEach((stage) => { out[stage] = Array.isArray(saved[stage]) ? saved[stage] : ClR.DEFAULT_BUCKETS[stage]; });
    return out;
  } catch {
    return ClR.DEFAULT_BUCKETS;
  }
}
type Drilldown = { title: string; subtitle: string; orders: AgingItem[] };
type DispatchDrilldown = { title: string; subtitle: string; orders: Dispatch.PendencyItem[] };
type ClDrilldown = { title: string; subtitle: string; orders: ClR.PendencyItem[] };

/** The ONE Delay Dashboard panel — a single route with a persistent nav
 *  strip + filter bar (never unmount on view switch) and client-side view
 *  switching, mirroring the source app's single-page-app shell. Only two
 *  primary views now — Report and NDD Shift Report — since every number
 *  on either one is itself a drill-down into the exact orders behind it,
 *  replacing what used to be six separate per-department tabs. */
export default function DelayDashboardPage() {
  const [view, setView] = useState<View>("report");
  const [returnView, setReturnView] = useState<View>("report");
  const [drilldown, setDrilldown] = useState<Drilldown | null>(null);
  const [dispatchDrilldown, setDispatchDrilldown] = useState<DispatchDrilldown | null>(null);
  const [clDrilldown, setClDrilldown] = useState<ClDrilldown | null>(null);

  const [facility, setFacility] = useState<Facility>("NXS1");
  const [nddOnly, setNddOnly] = useState(true);
  const [jit, setJit] = useState<Jit>("all");
  const [frFilter, setFrFilter] = useState<FrFilter>("all");
  const [frameFilter, setFrameFilter] = useState<FrameFilter>("all");
  const [international, setInternational] = useState<International>("all");
  const [lensTypeFilter, setLensTypeFilter] = useState<LensTypeFilter>("all");
  const [autoSec, setAutoSec] = useState(0);

  const [pidMasters, setPidMasters] = useState<{ updatedAt: string; source: string; cyl: string[]; noncyl: string[] } | null>(null);
  const [pidMastersLoading, setPidMastersLoading] = useState(true);
  const [pidMastersError, setPidMastersError] = useState<string | null>(null);
  const pidSets: PidSets = pidMasters ? buildPidSets(pidMasters.cyl, pidMasters.noncyl) : EMPTY_PID_SETS;

  const loadPidMasters = useCallback(async () => {
    setPidMastersLoading(true);
    setPidMastersError(null);
    try {
      const res = await fetch("/api/delay-dashboard/pid-masters");
      const payload = await res.json();
      if (!res.ok || payload.ok !== true) throw new Error(payload.error || `Request failed (${res.status})`);
      setPidMasters(payload.data);
    } catch (err) {
      setPidMastersError(err instanceof Error ? err.message : "Failed to load PID masters.");
    } finally {
      setPidMastersLoading(false);
    }
  }, []);

  useEffect(() => {
    // This effect intentionally loads the PID Vault once after mount — it rarely changes,
    // and the PID Masters view explicitly reloads it after an upload/reset.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPidMasters();
  }, [loadPidMasters]);

  const [dateOpen, setDateOpen] = useState(false);
  const [dateMode, setDateMode] = useState<DateMode>("allPeriod");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [startTime, setStartTime] = useState("00:00");
  const [endTime, setEndTime] = useState("23:59");
  const bounds = dateBounds();

  const [buckets, setBuckets] = useState<Record<DeptKey, BucketDef[]>>(DEFAULT_BUCKETS);
  const [shiftBuckets, setShiftBuckets] = useState<Record<DeptKey, BucketDef[]>>(DEFAULT_BUCKETS);
  const [deptView, setDeptView] = useState<DeptKey[]>(DEPT_ORDER);
  const [bucketsOpen, setBucketsOpen] = useState(false);
  const [shiftBucketsOpen, setShiftBucketsOpen] = useState(false);
  const [deptViewOpen, setDeptViewOpen] = useState(false);

  const [dispatchBuckets, setDispatchBuckets] = useState<Record<Dispatch.StageKey, Dispatch.BucketDef[]>>(Dispatch.DEFAULT_BUCKETS);
  const [dispatchDeptView, setDispatchDeptView] = useState<Dispatch.DeptKey[]>(Dispatch.DEPT_ORDER);
  const [dispatchBucketsOpen, setDispatchBucketsOpen] = useState(false);
  const [dispatchDeptViewOpen, setDispatchDeptViewOpen] = useState(false);

  const [clBuckets, setClBuckets] = useState<Record<ClR.StageKey, ClR.BucketDef[]>>(ClR.DEFAULT_BUCKETS);
  const [clTagFilter, setClTagFilter] = useState<ClR.TagFilter>("all");
  const [clBucketsOpen, setClBucketsOpen] = useState(false);
  const [clViewMode, setClViewMode] = useState<ClR.ViewMode>("order");

  useEffect(() => {
    // This effect intentionally hydrates client-only localStorage preferences after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBuckets(loadBucketsFrom(BUCKETS_STORAGE_KEY));
    setShiftBuckets(loadBucketsFrom(SHIFT_BUCKETS_STORAGE_KEY));
    setDeptView(loadDeptView());
    setDispatchBuckets(loadDispatchBuckets());
    setDispatchDeptView(loadDispatchDeptView());
    setClBuckets(loadClBuckets());
    try {
      const savedViewMode = localStorage.getItem(CL_VIEW_MODE_STORAGE_KEY);
      if (savedViewMode === "order" || savedViewMode === "shipment") setClViewMode(savedViewMode);
    } catch { /* ignore */ }
  }, []);

  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [qcfailData, setQcfailData] = useState<QcfailData | null>(null);
  const [warehouseData, setWarehouseData] = useState<PipelineData | null>(null);
  const [packingData, setPackingData] = useState<PipelineData | null>(null);
  const [dispatchData, setDispatchData] = useState<DispatchReportData | null>(null);
  const [dispatchLoading, setDispatchLoading] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [clData, setClData] = useState<DispatchReportData | null>(null);
  const [clLoading, setClLoading] = useState(false);
  const [clError, setClError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [lastGoodAt, setLastGoodAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const requestSequence = useRef(0);

  // Core data (Report / NDD Shift Report) loads eagerly — it's what's
  // visible by default. Dispatch Report and CL Report are each a large
  // fan-out of paginated NexS calls (15 and 18 (category, stage) pairs
  // respectively) sharing the app's one global upstream concurrency
  // limiter — firing all three eagerly on every filter change, no
  // matter which tab is open, was serializing 30+ jobs behind a
  // 12-slot queue and making the page look stuck. So Dispatch/CL load
  // lazily: once on first visit to their tab, and again only if a
  // filter changed since their last fetch (tracked via the *StaleRef
  // flags below) — never just from switching tabs back and forth.
  const load = useCallback(async (force = false) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const dateRange = dateRangeFor(dateMode, startDate, endDate, startTime, endTime);
      const base = { facility, nddOnly, jit, frFilter, international, dateRange, force };
      const post = (action: string, extra: Record<string, unknown> = {}) =>
        fetch("/api/delay-dashboard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...base, ...extra }),
        }).then((res) => res.json());

      const [r, q, w, p] = await Promise.all([
        post("report", { frameFilter }),
        post("qcfail"),
        post("warehouse"),
        post("packingDispatch"),
      ]);
      if (sequence !== requestSequence.current) return;
      const failed = [r, q, w, p].find((x) => x.ok !== true);
      if (failed) throw new Error(failed.error || "Request failed");
      setReportData(r.data as ReportData);
      setQcfailData(q.data as QcfailData);
      setWarehouseData(w.data as PipelineData);
      setPackingData(p.data as PipelineData);
      setFetchedAt(r.data.fetchedAt);
      setLastGoodAt(r.data.fetchedAt);
    } catch (err) {
      if (sequence !== requestSequence.current) return;
      setError(err instanceof Error ? err.message : "Failed to load.");
      setReportData(null);
      setFetchedAt(null);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [facility, nddOnly, jit, frFilter, frameFilter, international, dateMode, startDate, endDate, startTime, endTime]);

  const dispatchRequestSequence = useRef(0);
  const loadDispatch = useCallback(async (force = false) => {
    const sequence = ++dispatchRequestSequence.current;
    setDispatchLoading(true);
    setDispatchError(null);
    try {
      const dateRange = dateRangeFor(dateMode, startDate, endDate, startTime, endTime);
      const res = await fetch("/api/delay-dashboard/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facility, nddOnly, jit, international, dateRange, force }),
      }).then((r) => r.json());
      if (sequence !== dispatchRequestSequence.current) return;
      if (res.ok !== true) throw new Error(res.error || "Request failed");
      setDispatchData(res.data as DispatchReportData);
    } catch (err) {
      if (sequence !== dispatchRequestSequence.current) return;
      setDispatchError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      if (sequence === dispatchRequestSequence.current) setDispatchLoading(false);
    }
  }, [facility, nddOnly, jit, international, dateMode, startDate, endDate, startTime, endTime]);

  const clRequestSequence = useRef(0);
  const loadCl = useCallback(async (force = false) => {
    const sequence = ++clRequestSequence.current;
    setClLoading(true);
    setClError(null);
    try {
      const dateRange = dateRangeFor(dateMode, startDate, endDate, startTime, endTime);
      const res = await fetch("/api/delay-dashboard/cl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facility, nddOnly, jit, international, dateRange, force }),
      }).then((r) => r.json());
      if (sequence !== clRequestSequence.current) return;
      if (res.ok !== true) throw new Error(res.error || "Request failed");
      setClData(res.data as DispatchReportData);
    } catch (err) {
      if (sequence !== clRequestSequence.current) return;
      setClError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      if (sequence === clRequestSequence.current) setClLoading(false);
    }
  }, [facility, nddOnly, jit, international, dateMode, startDate, endDate, startTime, endTime]);

  useEffect(() => {
    // This effect intentionally synchronizes the selected filters with server data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Marks Dispatch/CL data stale on any relevant filter change, and
  // immediately refetches if that tab happens to be the active view —
  // otherwise the refetch is deferred to whenever the user next opens
  // that tab (see the view-triggered effects below).
  // This effect intentionally keyed on filters only (not `view`, deliberately
  // read but not depended on) — a plain tab switch must not retrigger it.
  const dispatchStaleRef = useRef(true);
  useEffect(() => {
    dispatchStaleRef.current = true;
    if (view === "dispatch") {
      dispatchStaleRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadDispatch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `view` is deliberately read, not a dependency: a plain tab switch must not retrigger this
  }, [loadDispatch]);
  const clStaleRef = useRef(true);
  useEffect(() => {
    clStaleRef.current = true;
    if (view === "cl") {
      clStaleRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadCl();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `view` is deliberately read, not a dependency: a plain tab switch must not retrigger this
  }, [loadCl]);
  // This effect intentionally fetches on first visit to a tab whose data was
  // marked stale by the filter-change effects above.
  useEffect(() => {
    if (view === "dispatch" && dispatchStaleRef.current) {
      dispatchStaleRef.current = false;
      void loadDispatch();
    }
    if (view === "cl" && clStaleRef.current) {
      clStaleRef.current = false;
      void loadCl();
    }
  }, [view, loadDispatch, loadCl]);

  useEffect(() => {
    if (!autoSec) return;
    const id = setInterval(() => {
      void load();
      if (view === "dispatch") void loadDispatch();
      if (view === "cl") void loadCl();
    }, autoSec * 1000);
    return () => clearInterval(id);
  }, [autoSec, load, loadDispatch, loadCl, view]);

  function setBucketSlot(dept: DeptKey, idx: number, hrs: string) {
    setBuckets((prev) => {
      const next = { ...prev, [dept]: [...prev[dept]] };
      next[dept][idx] = hrs === "" ? null : { op: ">", hrs: Math.max(0, Number(hrs) || 0) };
      localStorage.setItem(BUCKETS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }
  function resetBuckets() {
    setBuckets(DEFAULT_BUCKETS);
    localStorage.setItem(BUCKETS_STORAGE_KEY, JSON.stringify(DEFAULT_BUCKETS));
  }
  function setShiftBucketSlot(dept: DeptKey, idx: number, hrs: string) {
    setShiftBuckets((prev) => {
      const next = { ...prev, [dept]: [...prev[dept]] };
      next[dept][idx] = hrs === "" ? null : { op: ">", hrs: Math.max(0, Number(hrs) || 0) };
      localStorage.setItem(SHIFT_BUCKETS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }
  function resetShiftBuckets() {
    setShiftBuckets(DEFAULT_BUCKETS);
    localStorage.setItem(SHIFT_BUCKETS_STORAGE_KEY, JSON.stringify(DEFAULT_BUCKETS));
  }
  function toggleDept(dept: DeptKey) {
    setDeptView((prev) => {
      if (prev.length === 1 && prev[0] === dept) return prev;
      const next = prev.includes(dept) ? prev.filter((d) => d !== dept) : DEPT_ORDER.filter((d) => d === dept || prev.includes(d));
      localStorage.setItem(DEPT_VIEW_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }
  function setDispatchBucketSlot(stage: Dispatch.StageKey, idx: number, hrs: string) {
    setDispatchBuckets((prev) => {
      const next = { ...prev, [stage]: [...prev[stage]] };
      next[stage][idx] = hrs === "" ? null : { op: ">", hrs: Math.max(0, Number(hrs) || 0) };
      localStorage.setItem(DISPATCH_BUCKETS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }
  function resetDispatchBuckets() {
    setDispatchBuckets(Dispatch.DEFAULT_BUCKETS);
    localStorage.setItem(DISPATCH_BUCKETS_STORAGE_KEY, JSON.stringify(Dispatch.DEFAULT_BUCKETS));
  }
  function toggleDispatchDept(dept: Dispatch.DeptKey) {
    setDispatchDeptView((prev) => {
      if (prev.length === 1 && prev[0] === dept) return prev;
      const next = prev.includes(dept) ? prev.filter((d) => d !== dept) : Dispatch.DEPT_ORDER.filter((d) => d === dept || prev.includes(d));
      localStorage.setItem(DISPATCH_DEPT_VIEW_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }
  function setClBucketSlot(stage: ClR.StageKey, idx: number, hrs: string) {
    setClBuckets((prev) => {
      const next = { ...prev, [stage]: [...prev[stage]] };
      next[stage][idx] = hrs === "" ? null : { op: ">", hrs: Math.max(0, Number(hrs) || 0) };
      localStorage.setItem(CL_BUCKETS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }
  function resetClBuckets() {
    setClBuckets(ClR.DEFAULT_BUCKETS);
    localStorage.setItem(CL_BUCKETS_STORAGE_KEY, JSON.stringify(ClR.DEFAULT_BUCKETS));
  }
  function changeClViewMode(mode: ClR.ViewMode) {
    setClViewMode(mode);
    localStorage.setItem(CL_VIEW_MODE_STORAGE_KEY, mode);
  }
  function navigateTo(nextView: View) {
    setView(nextView);
    if (NDD_ONLY_LOCKED_VIEWS.includes(nextView)) setNddOnly(true);
  }
  function openDrilldown(title: string, subtitle: string, orders: AgingItem[]) {
    setReturnView(view);
    setDrilldown({ title, subtitle, orders });
    setView("drilldown");
  }
  function openDispatchDrilldown(title: string, subtitle: string, orders: Dispatch.PendencyItem[]) {
    setReturnView(view);
    setDispatchDrilldown({ title, subtitle, orders });
    setView("dispatchDrilldown");
  }
  function openClDrilldown(title: string, subtitle: string, orders: ClR.PendencyItem[]) {
    setReturnView(view);
    setClDrilldown({ title, subtitle, orders });
    setView("clDrilldown");
  }
  function closeDrilldown() {
    setDrilldown(null);
    setDispatchDrilldown(null);
    setClDrilldown(null);
    setView(returnView);
  }

  const dateLabel = dateMode === "allPeriod" ? "All Period"
    : dateMode === "today" ? "Today"
    : dateMode === "last7" ? "Last 7 Days"
    : dateMode === "last20" ? "Last 20 Days"
    : startDate ? (endDate && endDate !== startDate ? `${startDate} – ${endDate}` : startDate) : "Custom Range";

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Delay dashboard</div>
          <h1>Order Delay Dashboard</h1>
          <p className="lede">One panel for every order stuck across Warehouse, MEI, Fitting, QC, QC-Fail rework, and Packing &amp; Dispatch — live from NexS. Click any number to see exactly which orders it counts.</p>
        </div>
        <span className="badge good">
          <Gauge size={12} /> Live NexS monitoring
        </span>
      </div>

      <div className="tabs" style={{ marginBottom: 14, flexWrap: "wrap" }}>
        {NAV.map((n) => (
          <button key={n.view} type="button" className={`tab${view === n.view ? " active" : ""}`} onClick={() => navigateTo(n.view)}>
            {n.label}
          </button>
        ))}
        {view === "drilldown" && (
          <button type="button" className="tab active">{drilldown?.title || "Orders"}</button>
        )}
        {view === "dispatchDrilldown" && (
          <button type="button" className="tab active">{dispatchDrilldown?.title || "Orders"}</button>
        )}
        {view === "clDrilldown" && (
          <button type="button" className="tab active">{clDrilldown?.title || "Orders"}</button>
        )}
      </div>

      <div className="card card-pad stack" style={{ marginBottom: 14 }}>
        <div className="toolbar">
          <div className="field" style={{ minWidth: 100 }}>
            <label className="label" htmlFor="dd-facility">Facility</label>
            <div className="dl-filter-ico">
              <Building2 size={12} />
              <select id="dd-facility" className="select" value={facility} onChange={(e) => setFacility(e.target.value as Facility)}>
                <option value="NXS1">NXS1</option>
                <option value="NXS2">NXS2</option>
              </select>
            </div>
          </div>
          <label className="ctl-check dl-filter-check" title={NDD_ONLY_LOCKED_VIEWS.includes(view) ? "The NDD Shift Report is always P1-only" : "ON = NDD orders only (priority 1) | OFF = every order in the panel"}>
            <input
              type="checkbox"
              checked={nddOnly}
              disabled={NDD_ONLY_LOCKED_VIEWS.includes(view)}
              onChange={(e) => setNddOnly(e.target.checked)}
            /> <Zap size={12} /> <span>NDD Only</span>
          </label>
          <div className="field" style={{ minWidth: 165 }}>
            <label className="label" htmlFor="dd-jit">JIT</label>
            <div className="dl-filter-ico">
              <Timer size={12} />
              <select id="dd-jit" className="select" value={jit} onChange={(e) => setJit(e.target.value as Jit)}>
                <option value="all">All, JIT and NON JIT</option>
                <option value="jit">JIT only</option>
                <option value="nonjit">Non-JIT only</option>
              </select>
            </div>
          </div>
          {(view === "report" || view === "shiftReport") && (
            <div className="field" style={{ minWidth: 140 }}>
              <label className="label" htmlFor="dd-fr">FR Tag</label>
              <div className="dl-filter-ico">
                <Tag size={12} />
                <select id="dd-fr" className="select" value={frFilter} onChange={(e) => setFrFilter(e.target.value as FrFilter)}>
                  <option value="all">All, FR1 and FR2</option>
                  <option value="FR1">FR1 only</option>
                  <option value="FR2">FR2 only</option>
                </select>
              </div>
            </div>
          )}
          {(view === "report" || view === "shiftReport") && (
            <div className="field" style={{ minWidth: 140 }}>
              <label className="label" htmlFor="dd-frame">Frame type</label>
              <div className="dl-filter-ico">
                <Glasses size={12} />
                <select id="dd-frame" className="select" value={frameFilter} onChange={(e) => setFrameFilter(e.target.value as FrameFilter)}>
                  <option value="all">All frames</option>
                  <option value="fullrim">Full rim</option>
                  <option value="halfrim">Half rim</option>
                  <option value="rimless">Rimless</option>
                </select>
              </div>
            </div>
          )}
          {(view === "report" || view === "shiftReport") && (
            <div className="field" style={{ minWidth: 240 }}>
              <label className="label" htmlFor="dd-lens">Lens type</label>
              <div className="dl-filter-ico">
                <Layers size={12} />
                <select id="dd-lens" className="select" value={lensTypeFilter} onChange={(e) => setLensTypeFilter(e.target.value as LensTypeFilter)}>
                  <option value="all">All, SV and Stock PRG (Cyc, Non-Cyc and Mixed)</option>
                  <option value="single_vision">Single Vision</option>
                  <option value="stock_progressive">Stock Progressive (all)</option>
                  <optgroup label="Stock Progressive — by type">
                    <option value="stock_progressive_cyl">Cylindrical</option>
                    <option value="stock_progressive_noncyl">Non-Cylindrical</option>
                    <option value="stock_progressive_mixed">Mixed</option>
                  </optgroup>
                </select>
              </div>
            </div>
          )}
          <div className="field" style={{ minWidth: 165 }}>
            <label className="label" htmlFor="dd-intl">International</label>
            <div className="dl-filter-ico">
              <Globe size={12} />
              <select id="dd-intl" className="select" value={international} onChange={(e) => setInternational(e.target.value as International)}>
                <option value="all">All, Intl and Doms</option>
                <option value="intl">International only</option>
                <option value="nonintl">Non-International only</option>
              </select>
            </div>
          </div>
          <div className="field" style={{ position: "relative" }}>
            <label className="label">Date range</label>
            <button type="button" className={`button small${dateMode !== "allPeriod" ? " primary" : ""}`} onClick={() => setDateOpen((o) => !o)}>
              📅 {dateLabel}
            </button>
            {dateOpen && (
              <div className="card card-pad stack" style={{ position: "absolute", top: 54, left: 0, zIndex: 30, width: 280 }}>
                <div className="toolbar">
                  {(["allPeriod", "today", "last7", "last20", "custom"] as DateMode[]).map((m) => (
                    <button key={m} type="button" className={`filter-pill${dateMode === m ? " active" : ""}`}
                      onClick={() => { setDateMode(m); if (m !== "custom") setDateOpen(false); }}>
                      {m === "allPeriod" ? "All Period" : m === "today" ? "Today" : m === "last7" ? "Last 7 Days" : m === "last20" ? "Last 20 Days" : "Custom"}
                    </button>
                  ))}
                </div>
                {dateMode === "custom" && (
                  <div className="stack">
                    <div className="form-grid">
                      <div className="field"><label className="label">Start</label><input type="date" className="input" min={bounds.min} max={bounds.max} value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
                      <div className="field"><label className="label">End</label><input type="date" className="input" min={bounds.min} max={bounds.max} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
                    </div>
                    <div className="form-grid">
                      <div className="field"><label className="label">From</label><input type="time" className="input" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></div>
                      <div className="field"><label className="label">To</label><input type="time" className="input" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></div>
                    </div>
                    <span className="dim" style={{ fontSize: 10 }}>Limited to {bounds.min} – {bounds.max} (max 20 days back)</span>
                    <button type="button" className="button primary small" onClick={() => setDateOpen(false)}>Apply</button>
                  </div>
                )}
              </div>
            )}
          </div>
          {view === "report" && (
            <div className="field" style={{ position: "relative" }}>
              <label className="label">Departments</label>
              <button type="button" className={`button small${deptView.length !== DEPT_ORDER.length ? " primary" : ""}`} onClick={() => setDeptViewOpen((o) => !o)}>
                ▤ Departments{deptView.length !== DEPT_ORDER.length ? ` (${deptView.length}/${DEPT_ORDER.length})` : ""}
              </button>
              {deptViewOpen && (
                <div className="card card-pad stack" style={{ position: "absolute", top: 54, left: 0, zIndex: 30, width: 220 }}>
                  {DEPT_ORDER.map((dept) => {
                    const checked = deptView.includes(dept);
                    const isLastOne = checked && deptView.length === 1;
                    return (
                      <label key={dept} className="ctl-check" style={{ justifyContent: "flex-start" }} title={isLastOne ? "At least one department must stay selected" : ""}>
                        <input type="checkbox" checked={checked} disabled={isLastOne} onChange={() => toggleDept(dept)} />
                        <span>{DEPT_META[dept].ico} {DEPT_META[dept].name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {view === "report" && (
            <div className="field" style={{ position: "relative" }}>
              <label className="label">Hour buckets</label>
              <button type="button" className="button small" onClick={() => setBucketsOpen((o) => !o)}><Settings size={12} /> Configure</button>
              {bucketsOpen && (
                <div className="card card-pad stack" style={{ position: "absolute", top: 54, right: 0, zIndex: 30, width: 360 }}>
                  <div className="toolbar" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                    <span className="dim" style={{ fontSize: 10 }}>Department Summary hour thresholds</span>
                    <button type="button" className="button ghost small" onClick={resetBuckets}>Reset</button>
                  </div>
                  {DEPT_ORDER.map((dept) => (
                    <div key={dept} className="toolbar" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                      <span style={{ fontSize: 11, minWidth: 96 }}>{DEPT_META[dept].name}</span>
                      {[0, 1, 2].map((idx) => (
                        <input key={idx} type="number" min="0" step="0.5" className="input mono" style={{ width: 50, height: 28, padding: "0 6px", flexShrink: 0 }}
                          value={buckets[dept]?.[idx]?.hrs ?? ""} placeholder="off"
                          onChange={(e) => setBucketSlot(dept, idx, e.target.value)} />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {view === "shiftReport" && (
            <div className="field" style={{ position: "relative" }}>
              <label className="label">Hour buckets</label>
              <button type="button" className="button small" onClick={() => setShiftBucketsOpen((o) => !o)}><Settings size={12} /> Configure</button>
              {shiftBucketsOpen && (
                <div className="card card-pad stack" style={{ position: "absolute", top: 54, right: 0, zIndex: 30, width: 360 }}>
                  <div className="toolbar" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                    <span className="dim" style={{ fontSize: 10 }}>NDD Shift Report hour thresholds — independent of Department Summary&apos;s</span>
                    <button type="button" className="button ghost small" onClick={resetShiftBuckets}>Reset</button>
                  </div>
                  {DEPT_ORDER.map((dept) => (
                    <div key={dept} className="toolbar" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                      <span style={{ fontSize: 11, minWidth: 96 }}>{DEPT_META[dept].name}</span>
                      {[0, 1, 2].map((idx) => (
                        <input key={idx} type="number" min="0" step="0.5" className="input mono" style={{ width: 50, height: 28, padding: "0 6px", flexShrink: 0 }}
                          value={shiftBuckets[dept]?.[idx]?.hrs ?? ""} placeholder="off"
                          onChange={(e) => setShiftBucketSlot(dept, idx, e.target.value)} />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {view === "dispatch" && (
            <div className="field" style={{ position: "relative" }}>
              <label className="label">Categories</label>
              <button type="button" className={`button small${dispatchDeptView.length !== Dispatch.DEPT_ORDER.length ? " primary" : ""}`} onClick={() => setDispatchDeptViewOpen((o) => !o)}>
                ▤ Categories{dispatchDeptView.length !== Dispatch.DEPT_ORDER.length ? ` (${dispatchDeptView.length}/${Dispatch.DEPT_ORDER.length})` : ""}
              </button>
              {dispatchDeptViewOpen && (
                <div className="card card-pad stack" style={{ position: "absolute", top: 54, left: 0, zIndex: 30, width: 220 }}>
                  {Dispatch.DEPT_ORDER.map((dept) => {
                    const checked = dispatchDeptView.includes(dept);
                    const isLastOne = checked && dispatchDeptView.length === 1;
                    return (
                      <label key={dept} className="ctl-check" style={{ justifyContent: "flex-start" }} title={isLastOne ? "At least one category must stay selected" : ""}>
                        <input type="checkbox" checked={checked} disabled={isLastOne} onChange={() => toggleDispatchDept(dept)} />
                        <span>{Dispatch.DEPT_META[dept].ico} {Dispatch.DEPT_META[dept].name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {view === "dispatch" && (
            <div className="field" style={{ position: "relative" }}>
              <label className="label">Hour buckets</label>
              <button type="button" className="button small" onClick={() => setDispatchBucketsOpen((o) => !o)}><Settings size={12} /> Configure</button>
              {dispatchBucketsOpen && (
                <div className="card card-pad stack" style={{ position: "absolute", top: 54, right: 0, zIndex: 30, width: 360 }}>
                  <div className="toolbar" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                    <span className="dim" style={{ fontSize: 10 }}>Per-stage delay thresholds — shared across every category that runs the stage</span>
                    <button type="button" className="button ghost small" onClick={resetDispatchBuckets}>Reset</button>
                  </div>
                  {Dispatch.STAGE_ORDER.map((stage) => (
                    <div key={stage} className="toolbar" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                      <span style={{ fontSize: 11, minWidth: 96 }}>{Dispatch.STAGE_META[stage].label}</span>
                      {[0, 1, 2].map((idx) => (
                        <input key={idx} type="number" min="0" step="0.5" className="input mono" style={{ width: 50, height: 28, padding: "0 6px", flexShrink: 0 }}
                          value={dispatchBuckets[stage]?.[idx]?.hrs ?? ""} placeholder="off"
                          onChange={(e) => setDispatchBucketSlot(stage, idx, e.target.value)} />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {view === "cl" && (
            <div className="field" style={{ minWidth: 165 }}>
              <label className="label" htmlFor="dd-cltag">CL Tag</label>
              <div className="dl-filter-ico">
                <Tag size={12} />
                <select id="dd-cltag" className="select" value={clTagFilter} onChange={(e) => setClTagFilter(e.target.value as ClR.TagFilter)}>
                  <option value="all">All, CL-FR0 and Bulk</option>
                  <option value="CL">CL-FR0 only</option>
                  <option value="BULK">Bulk only</option>
                </select>
              </div>
            </div>
          )}
          {view === "cl" && (clTagFilter === "all" || clTagFilter === "BULK") && (
            <div className="field">
              <label className="label">Bulk view</label>
              <div className="tabs">
                <button type="button" className={`tab${clViewMode === "order" ? " active" : ""}`} onClick={() => changeClViewMode("order")} title="One row per order/shipment (default, matches every other category in this app)">Order wise</button>
                <button type="button" className={`tab${clViewMode === "shipment" ? " active" : ""}`} onClick={() => changeClViewMode("shipment")} title="One row per individual item/unit — matches NexS's own monitor panel counts, e.g. a Bulk shipment with 200 lens boxes counts as 200">Shipment wise</button>
              </div>
            </div>
          )}
          {view === "cl" && (
            <div className="field" style={{ position: "relative" }}>
              <label className="label">Hour buckets</label>
              <button type="button" className="button small" onClick={() => setClBucketsOpen((o) => !o)}><Settings size={12} /> Configure</button>
              {clBucketsOpen && (
                <div className="card card-pad stack" style={{ position: "absolute", top: 54, right: 0, zIndex: 30, width: 360 }}>
                  <div className="toolbar" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                    <span className="dim" style={{ fontSize: 10 }}>Per-stage delay thresholds — shared across every category that runs the stage</span>
                    <button type="button" className="button ghost small" onClick={resetClBuckets}>Reset</button>
                  </div>
                  {ClR.STAGE_ORDER.map((stage) => (
                    <div key={stage} className="toolbar" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                      <span style={{ fontSize: 11, minWidth: 140 }}>{ClR.STAGE_META[stage].label}</span>
                      {[0, 1, 2].map((idx) => (
                        <input key={idx} type="number" min="0" step="0.5" className="input mono" style={{ width: 50, height: 28, padding: "0 6px", flexShrink: 0 }}
                          value={clBuckets[stage]?.[idx]?.hrs ?? ""} placeholder="off"
                          onChange={(e) => setClBucketSlot(stage, idx, e.target.value)} />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="field" style={{ minWidth: 110 }}>
            <label className="label" htmlFor="dd-auto">Auto-refresh</label>
            <div className="dl-filter-ico">
              <Repeat size={12} />
              <select id="dd-auto" className="select" value={autoSec} onChange={(e) => setAutoSec(Number(e.target.value))}>
                <option value={0}>Off</option>
                <option value={30}>30 sec</option>
                <option value={60}>1 min</option>
                <option value={300}>5 min</option>
                <option value={600}>10 min</option>
              </select>
            </div>
          </div>
        </div>
        <div className="toolbar">
          <button
            type="button"
            className="button primary"
            disabled={loading || (view === "dispatch" && dispatchLoading) || (view === "cl" && clLoading)}
            onClick={() => {
              void load(true);
              if (view === "dispatch") void loadDispatch(true);
              if (view === "cl") void loadCl(true);
            }}
          >
            {loading || (view === "dispatch" && dispatchLoading) || (view === "cl" && clLoading)
              ? <span className="spinner" /> : <RefreshCw size={13} />}
            {" "}
            {loading || (view === "dispatch" && dispatchLoading) || (view === "cl" && clLoading) ? "Refreshing…" : "Refresh"}
          </button>
          {fetchedAt && <span className="last-updated dim mono">Updated {fmtTime(fetchedAt)}</span>}
        </div>
        {error && (
          <div className="alert error">
            ⚠ Live data unavailable — {error}{lastGoodAt ? ` (showing last successful update from ${fmtTime(lastGoodAt)})` : " (no data loaded yet)"}
          </div>
        )}
        {view === "dispatch" && dispatchError && (
          <div className="alert error">⚠ Dispatch Report data unavailable — {dispatchError}</div>
        )}
        {view === "cl" && clError && (
          <div className="alert error">⚠ CL Report data unavailable — {clError}</div>
        )}
      </div>

      {view === "report" && reportData && (
        <ReportView
          stages={reportData.stages}
          qcfailOrders={qcfailData?.orders ?? []}
          warehouseOrders={warehouseData?.orders ?? []}
          packingOrders={packingData?.orders ?? []}
          buckets={buckets}
          deptView={deptView}
          pidSets={pidSets}
          lensTypeFilter={lensTypeFilter}
          onDrilldown={openDrilldown}
        />
      )}
      {view === "shiftReport" && (
        <ShiftReportView
          facility={facility}
          jit={jit}
          frFilter={frFilter}
          stages={reportData?.stages ?? null}
          qcfailOrders={qcfailData?.orders ?? []}
          warehouseOrders={warehouseData?.orders ?? []}
          packingOrders={packingData?.orders ?? []}
          fetchedAt={fetchedAt}
          buckets={shiftBuckets}
          pidSets={pidSets}
          lensTypeFilter={lensTypeFilter}
          onDrilldown={openDrilldown}
        />
      )}
      {view === "dispatch" && dispatchData && (
        <DispatchReportView
          categories={dispatchData.categories}
          buckets={dispatchBuckets}
          deptView={dispatchDeptView}
          onDrilldown={openDispatchDrilldown}
        />
      )}
      {view === "dispatch" && !dispatchData && (
        <div className="card empty">
          <span>
            <strong>{dispatchLoading ? "Loading Dispatch Report…" : dispatchError ? "Dispatch data unavailable" : "No data yet"}</strong>
            {!dispatchLoading && dispatchError && <>{dispatchError}</>}
          </span>
        </div>
      )}
      {view === "cl" && clData && (
        <ClReportView
          categories={clData.categories}
          buckets={clBuckets}
          tagFilter={clTagFilter}
          viewMode={clViewMode}
          onDrilldown={openClDrilldown}
        />
      )}
      {view === "cl" && !clData && (
        <div className="card empty">
          <span>
            <strong>{clLoading ? "Loading CL Report…" : clError ? "CL data unavailable" : "No data yet"}</strong>
            {!clLoading && clError && <>{clError}</>}
          </span>
        </div>
      )}
      {view === "pidMasters" && (
        <PidMastersView
          stats={pidMasters ? { updatedAt: pidMasters.updatedAt, source: pidMasters.source, cylCount: pidMasters.cyl.length, noncylCount: pidMasters.noncyl.length } : null}
          loading={pidMastersLoading}
          error={pidMastersError}
          onReload={loadPidMasters}
        />
      )}
      {view === "drilldown" && drilldown && (
        <DrilldownView title={drilldown.title} subtitle={drilldown.subtitle} orders={drilldown.orders} onBack={closeDrilldown} />
      )}
      {view === "dispatchDrilldown" && dispatchDrilldown && (
        <DispatchDrilldownView title={dispatchDrilldown.title} subtitle={dispatchDrilldown.subtitle} orders={dispatchDrilldown.orders} onBack={closeDrilldown} />
      )}
      {view === "clDrilldown" && clDrilldown && (
        <ClDrilldownView title={clDrilldown.title} subtitle={clDrilldown.subtitle} orders={clDrilldown.orders} onBack={closeDrilldown} />
      )}
    </div>
  );
}
