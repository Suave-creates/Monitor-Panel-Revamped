"use client";

import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  Clock3,
  Download,
  PackageCheck,
  RefreshCw,
  SearchCheck,
  Tags,
  Truck,
} from "lucide-react";
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

const API_URL = "/api/packing-dispatch/do-order-visibility";
const UNKNOWN_DO_TYPE = "__UNKNOWN__";

type Tone = "teal" | "rose" | "amber" | "violet" | "blue";
type ViewName = "shipments" | "pids";

type DashboardWarning = {
  code: string;
  message: string;
  affected?: number;
};

type PidDetail = {
  productId: string | null;
  description: string;
  classification: string;
  required: number;
  picked: number;
  pending: number;
};

type ShipmentRow = {
  id: string;
  status: string;
  customer: string;
  doNumber: string;
  poNumber: string;
  doType: string;
  required: number;
  picked: number;
  pending: number;
  pidCount: number;
  createdAt: string | null;
  ageHours: number | null;
  classifications: string[];
  pidDetails: PidDetail[];
};

type PidRow = {
  pid: string;
  description: string;
  classification: string;
  hsnCode: string;
  hsnClassification: string;
  required: number;
  picked: number;
  pending: number;
  shipmentCount: number;
};

type DashboardPayload = {
  ok: true;
  generatedAt: string;
  range: { from: string; to: string; timeZone: string };
  configuration: {
    facility: string;
    channel: string;
    lookbackDays: number;
    excludedClassifications: string[];
  };
  summary: {
    apiReportedTotal: number | null;
    fetchedTotal: number;
    duplicatesRemoved: number;
    dispatched: number;
    terminalExcluded: number;
    activeFromList: number;
    detailFailures: number;
    terminalAfterDetail: number;
    blankUnitsRemoved: number;
    blankOnlyShipmentsHidden: number;
    emptyShipmentsHidden: number;
    unmatchedDoType: number;
    catalogFailures: number;
    catalogCache: { hit: number; miss: number; coalesced: number };
    shownShipments: number;
    impactedPids: number;
  };
  warnings: DashboardWarning[];
  shipments: ShipmentRow[];
  pids: PidRow[];
  cache: { status: "hit" | "miss" | "coalesced"; ageMs: number; ttlMs: number };
};

type JsonRecord = Record<string, unknown>;

const NUMBER_FORMAT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const FETCHED_FORMAT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

const AGING_BUCKETS = [
  { label: "0–24 hrs", tone: "teal" as Tone, matches: (hours: number) => hours < 24 },
  { label: "24–48 hrs", tone: "amber" as Tone, matches: (hours: number) => hours >= 24 && hours < 48 },
  { label: "48–72 hrs", tone: "rose" as Tone, matches: (hours: number) => hours >= 48 && hours < 72 },
  { label: "72–96 hrs", tone: "rose" as Tone, matches: (hours: number) => hours >= 72 && hours < 96 },
  { label: "96+ hrs", tone: "rose" as Tone, matches: (hours: number) => hours >= 96 },
];

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function isDashboardPayload(value: unknown): value is DashboardPayload {
  const payload = asRecord(value);
  return payload?.ok === true
    && typeof payload.generatedAt === "string"
    && Boolean(asRecord(payload.range))
    && Boolean(asRecord(payload.configuration))
    && Boolean(asRecord(payload.summary))
    && Boolean(asRecord(payload.cache))
    && Array.isArray(payload.warnings)
    && Array.isArray(payload.shipments)
    && Array.isArray(payload.pids);
}

function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(Number.isFinite(value) ? value : 0);
}

function formatStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function formatDoType(doType: string): string {
  if (!doType || doType === "—") return "Unknown";
  const normalized = doType.toUpperCase();
  if (normalized.startsWith("INTERNATIONAL")) return "International";
  return doType.replace(/_/g, " ");
}

function formatAge(hours: number | null): string {
  if (hours === null) return "Unknown";
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const roundedHours = Math.round(hours);
  const days = Math.floor(roundedHours / 24);
  const remainingHours = roundedHours % 24;
  return `${days}d ${remainingHours}h`;
}

function statusBadge(status: string): string {
  if (/CANCEL|FAIL|REJECT/.test(status)) return "badge bad";
  if (/AWB|PACK|DISPATCH|DELIVER/.test(status)) return "badge good";
  if (/QC/.test(status)) return "badge violet";
  if (/PROCESS|PEND|HOLD/.test(status)) return "badge warn";
  return "badge info";
}

function statusTone(status: string): Tone {
  if (/CANCEL|FAIL|REJECT/.test(status)) return "rose";
  if (/AWB|PACK|DISPATCH|DELIVER/.test(status)) return "teal";
  if (/QC/.test(status)) return "violet";
  if (/PROCESS|PEND|HOLD/.test(status)) return "amber";
  return "blue";
}

function ageBadge(hours: number | null): string {
  if (hours === null) return "badge";
  if (hours < 24) return "badge good";
  if (hours < 48) return "badge warn";
  return "badge bad";
}

function classificationBadge(classification: string): string {
  if (classification === "Contact Lens") return "badge info";
  if (classification === "Contact Lens Solution") return "badge good";
  if (classification === "Eyeframe") return "badge violet";
  if (classification === "Unknown") return "badge";
  return "badge warn";
}

function percentage(picked: number, required: number): number | null {
  if (required <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((picked / required) * 100)));
}

function csvCell(value: string | number | null): string {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number | null>>) {
  const content = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportTimestamp(): string {
  return new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
}

function MetricCard({
  label,
  value,
  foot,
  tone,
  icon,
}: {
  label: string;
  value: string;
  foot: string;
  tone: Tone;
  icon: ReactNode;
}) {
  return (
    <article className={`metric ${tone}`}>
      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <span className="metric-label">{label}</span>
        <span aria-hidden="true">{icon}</span>
      </div>
      <div className="metric-value" style={{ color: "currentColor" }}>{value}</div>
      <div className="metric-foot">{foot}</div>
    </article>
  );
}

function Completion({ picked, required }: { picked: number; required: number }) {
  const complete = percentage(picked, required);
  if (complete === null) return <span className="dim">—</span>;
  const tone = complete >= 100 ? "var(--teal)" : complete > 0 ? "var(--amber)" : "var(--rose)";
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
      <span
        aria-label={`${complete}% complete`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={complete}
        style={{ width: 54, height: 5, overflow: "hidden", borderRadius: 99, background: "var(--surface-3)" }}
      >
        <span style={{ display: "block", width: `${complete}%`, height: "100%", background: tone }} />
      </span>
      <span className="mono" style={{ minWidth: 34, color: tone }}>{complete}%</span>
    </div>
  );
}

function AgingMatrix({ rows }: { rows: ShipmentRow[] }) {
  const statusCounts = new Map<string, number>();
  rows.forEach((row) => statusCounts.set(row.status, (statusCounts.get(row.status) || 0) + 1));
  const statuses = [...statusCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([status]) => status);
  const unknownAge = rows.filter((row) => row.ageHours === null);
  const buckets = unknownAge.length > 0
    ? [...AGING_BUCKETS, { label: "Unknown", tone: "blue" as Tone, matches: Number.isNaN }]
    : AGING_BUCKETS;

  return (
    <div className="table-wrap">
      <table aria-label="Shipment aging by status" style={{ minWidth: Math.max(520, 180 + statuses.length * 130) }}>
        <thead>
          <tr>
            <th scope="col">Age bucket</th>
            {statuses.map((status) => <th scope="col" className="right" key={status}>{formatStatus(status)}</th>)}
            <th scope="col" className="right">Total</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((bucket) => {
            const bucketRows = bucket.label === "Unknown"
              ? unknownAge
              : rows.filter((row) => row.ageHours !== null && bucket.matches(row.ageHours));
            return (
              <tr key={bucket.label}>
                <td><span className={bucket.tone}>{bucket.label}</span></td>
                {statuses.map((status) => (
                  <td className="right mono" key={status}>{bucketRows.filter((row) => row.status === status).length}</td>
                ))}
                <td className="right mono"><strong>{bucketRows.length}</strong></td>
              </tr>
            );
          })}
          <tr>
            <td><strong>Total</strong></td>
            {statuses.map((status) => <td className="right mono teal" key={status}><strong>{statusCounts.get(status)}</strong></td>)}
            <td className="right mono teal"><strong>{rows.length}</strong></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PidRankingTable({ rows, label }: { rows: PidRow[]; label: string }) {
  return (
    <div className="table-wrap">
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">PID</th>
            <th scope="col" className="right">Required</th>
            <th scope="col" className="right">Pending</th>
            <th scope="col" className="right">Shipments</th>
          </tr>
        </thead>
        <tbody>
          {rows.length > 0 ? rows.map((row) => (
            <tr key={row.pid}>
              <td className="table-id">{row.pid}</td>
              <td className="right mono blue">{formatNumber(row.required)}</td>
              <td className={`right mono ${row.pending > 0 ? "amber" : "dim"}`}>{formatNumber(row.pending)}</td>
              <td className="right mono teal">{formatNumber(row.shipmentCount)}</td>
            </tr>
          )) : (
            <tr><td className="table-empty" colSpan={4}>No PIDs in the current classification view.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function DoOrderVisibilityPage() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewName>("shipments");
  const [doTypeFilter, setDoTypeFilter] = useState("ALL");
  const [classFilter, setClassFilter] = useState<Set<string>>(() => new Set());
  const [expandedShipments, setExpandedShipments] = useState<Set<string>>(() => new Set());

  const loadDashboard = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    if (refresh) setRefreshing(true);
    else setInitialLoading(true);
    setError(null);

    try {
      const response = await fetch(API_URL, {
        method: refresh ? "POST" : "GET",
        headers: refresh ? { "Content-Type": "application/json" } : undefined,
        body: refresh ? JSON.stringify({ refresh: true }) : undefined,
        cache: "no-store",
        signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = asRecord(payload)?.error;
        throw new Error(typeof message === "string" ? message : `Dashboard request failed (HTTP ${response.status}).`);
      }
      if (!isDashboardPayload(payload)) throw new Error("The dashboard returned an invalid response.");

      setData(payload);
      setExpandedShipments(new Set());
      const availableClasses = new Set(payload.pids.map((pid) => pid.classification));
      setClassFilter((current) => new Set([...current].filter((classification) => availableClasses.has(classification))));
      const availableDoTypes = new Set(payload.shipments.map((shipment) => shipment.doType));
      setDoTypeFilter((current) => {
        if (current === "ALL") return current;
        if (current === UNKNOWN_DO_TYPE) return availableDoTypes.has("—") ? current : "ALL";
        return availableDoTypes.has(current) ? current : "ALL";
      });
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") return;
      setError(requestError instanceof Error ? requestError.message : "Unable to load the dashboard.");
    } finally {
      if (!signal?.aborted) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadDashboard(false, controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadDashboard]);

  const classificationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    data?.pids.forEach((pid) => counts.set(pid.classification, (counts.get(pid.classification) || 0) + 1));
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  const filteredPids = useMemo(() => {
    if (!data) return [];
    if (classFilter.size === 0) return data.pids;
    return data.pids.filter((pid) => classFilter.has(pid.classification));
  }, [classFilter, data]);

  const classScopedShipments = useMemo(() => {
    if (!data) return [];
    if (classFilter.size === 0) return data.shipments;
    return data.shipments.filter((shipment) => shipment.classifications.some((classification) => classFilter.has(classification)));
  }, [classFilter, data]);

  const doTypeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    classScopedShipments.forEach((shipment) => {
      if (shipment.doType !== "—") counts.set(shipment.doType, (counts.get(shipment.doType) || 0) + 1);
    });
    return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  }, [classScopedShipments]);

  const unknownDoTypeCount = useMemo(
    () => classScopedShipments.filter((shipment) => shipment.doType === "—").length,
    [classScopedShipments],
  );

  const effectiveDoTypeFilter = doTypeFilter === "ALL"
    || (doTypeFilter === UNKNOWN_DO_TYPE ? unknownDoTypeCount > 0 : doTypeOptions.some(([type]) => type === doTypeFilter))
    ? doTypeFilter
    : "ALL";

  const visibleShipments = useMemo(() => {
    if (effectiveDoTypeFilter === "ALL") return classScopedShipments;
    if (effectiveDoTypeFilter === UNKNOWN_DO_TYPE) return classScopedShipments.filter((shipment) => shipment.doType === "—");
    return classScopedShipments.filter((shipment) => shipment.doType === effectiveDoTypeFilter);
  }, [classScopedShipments, effectiveDoTypeFilter]);

  const statusMetrics = useMemo(() => {
    const counts = new Map<string, number>();
    classScopedShipments.forEach((shipment) => counts.set(shipment.status, (counts.get(shipment.status) || 0) + 1));
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [classScopedShipments]);

  const pidTotals = useMemo(() => filteredPids.reduce((totals, pid) => ({
    required: totals.required + pid.required,
    picked: totals.picked + pid.picked,
    pending: totals.pending + pid.pending,
  }), { required: 0, picked: 0, pending: 0 }), [filteredPids]);

  const topPendingPids = useMemo(() => [...filteredPids]
    .sort((a, b) => b.pending - a.pending || b.shipmentCount - a.shipmentCount || a.pid.localeCompare(b.pid))
    .slice(0, 10), [filteredPids]);

  const highestImpactPids = useMemo(() => [...filteredPids]
    .sort((a, b) => b.shipmentCount - a.shipmentCount || b.pending - a.pending || a.pid.localeCompare(b.pid))
    .slice(0, 10), [filteredPids]);

  function toggleClassification(classification: string) {
    setClassFilter((current) => {
      const next = new Set(current);
      if (next.has(classification)) next.delete(classification);
      else next.add(classification);
      return next;
    });
    setDoTypeFilter("ALL");
  }

  function toggleShipment(id: string) {
    setExpandedShipments((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exportShipments() {
    if (visibleShipments.length === 0) return;
    downloadCsv(`DO_Shipments_${exportTimestamp()}.csv`, [
      "Shipping ID", "Status", "Customer", "DO Number", "PO Number", "DO Type",
      "Required", "Picked", "Pending", "PID Count", "Age (hrs)", "Completed (%)",
    ], visibleShipments.map((shipment) => [
      shipment.id,
      shipment.status,
      shipment.customer,
      shipment.doNumber,
      shipment.poNumber,
      shipment.doType === "—" ? "Unknown" : shipment.doType,
      shipment.required,
      shipment.picked,
      shipment.pending,
      shipment.pidCount,
      shipment.ageHours === null ? "" : shipment.ageHours.toFixed(2),
      percentage(shipment.picked, shipment.required) ?? "",
    ]));
  }

  function exportPids() {
    if (filteredPids.length === 0) return;
    downloadCsv(`DO_PIDs_${exportTimestamp()}.csv`, [
      "Product ID", "Description", "Classification", "HSN Code", "HSN Class",
      "Required", "Picked", "Pending", "Shipments",
    ], filteredPids.map((pid) => [
      pid.pid,
      pid.description,
      pid.classification,
      pid.hsnCode,
      pid.hsnClassification,
      pid.required,
      pid.picked,
      pid.pending,
      pid.shipmentCount,
    ]));
  }

  const fetchedAt = data ? FETCHED_FORMAT.format(new Date(data.generatedAt)) : "Not fetched";
  const cacheLabel = data
    ? data.cache.status === "hit"
      ? `cached ${Math.max(0, Math.round(data.cache.ageMs / 1_000))}s`
      : data.cache.status === "coalesced" ? "shared refresh" : "live fetch"
    : "waiting";

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Packing &amp; dispatch · {data?.configuration.facility || "NXS1"}</div>
          <h1>DO Order Visibility</h1>
          <p className="lede">Active BULKTOVENDOR shipments, aging pressure and PID-level picking impact across the latest seven calendar days.</p>
        </div>
        <div className="toolbar">
          <span className="badge info"><span className="live-dot" /> {data?.configuration.channel || "BULKTOVENDOR"}</span>
          <span className="badge mono" title={data ? `Data window ${data.range.from} to ${data.range.to} (${data.range.timeZone})` : undefined}>
            {fetchedAt} · {cacheLabel}
          </span>
          <button className="button primary" type="button" disabled={initialLoading || refreshing} onClick={() => void loadDashboard(true)}>
            {refreshing ? <span className="spinner" /> : <RefreshCw size={15} />}
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {error && data && (
        <div className="alert error section-gap" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span><strong>Refresh failed.</strong> The last successful dashboard remains visible. {error}</span>
        </div>
      )}

      {initialLoading && !data ? (
        <section className="card empty" aria-live="polite" aria-busy="true">
          <div>
            <span className="spinner" style={{ display: "inline-block", width: 24, height: 24, color: "var(--teal)" }} />
            <strong style={{ marginTop: 14 }}>Building live dashboard</strong>
            <span>Fetching shipment pages, WMS details, DO metadata and product classifications.</span>
          </div>
        </section>
      ) : error && !data ? (
        <section className="card empty" role="alert">
          <div>
            <AlertTriangle size={28} className="rose" />
            <strong>Dashboard unavailable</strong>
            <span>{error}</span>
            <div style={{ marginTop: 16 }}>
              <button className="button" type="button" onClick={() => void loadDashboard(true)}><RefreshCw size={14} /> Try again</button>
            </div>
          </div>
        </section>
      ) : data ? (
        <div className="stack" aria-live="polite" aria-busy={refreshing}>
          {data.warnings.length > 0 && (
            <section className="alert warning" role="status">
              <AlertTriangle size={16} aria-hidden="true" style={{ flex: "0 0 auto" }} />
              <div>
                <strong>Partial-data notice</strong>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {data.warnings.map((warning) => (
                    <li key={`${warning.code}-${warning.message}`} style={{ marginTop: 3 }}>
                      {warning.message}{warning.affected ? ` (${formatNumber(warning.affected)})` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          <section aria-label="Classification filters" className="card card-pad">
            <div className="toolbar" style={{ justifyContent: "space-between" }}>
              <div>
                <div className="card-subtitle" style={{ marginBottom: 9 }}>Classification · multi-select</div>
                <div className="filter-strip">
                  <button
                    className={`filter-pill ${classFilter.size === 0 ? "active" : ""}`}
                    type="button"
                    aria-pressed={classFilter.size === 0}
                    onClick={() => { setClassFilter(new Set()); setDoTypeFilter("ALL"); }}
                  >
                    All <span className="mono">{data.pids.length}</span>
                  </button>
                  {classificationCounts.map(([classification, count]) => (
                    <button
                      className={`filter-pill ${classFilter.has(classification) ? "active" : ""}`}
                      type="button"
                      aria-pressed={classFilter.has(classification)}
                      onClick={() => toggleClassification(classification)}
                      key={classification}
                    >
                      {classification} <span className="mono">{count}</span>
                    </button>
                  ))}
                </div>
              </div>
              <span className="dim" style={{ fontSize: 10 }}>Shipment quantities remain whole-shipment totals.</span>
            </div>
          </section>

          <section className="metric-grid" aria-label="Active shipment status summary">
            <MetricCard label="Active shipments" value={formatNumber(classScopedShipments.length)} foot="classification-scoped" tone="blue" icon={<Truck size={17} />} />
            {statusMetrics.map(([status, count]) => (
              <MetricCard
                key={status}
                label={formatStatus(status)}
                value={formatNumber(count)}
                foot="shipments"
                tone={statusTone(status)}
                icon={<PackageCheck size={17} />}
              />
            ))}
          </section>

          <div className="toolbar" style={{ justifyContent: "space-between" }}>
            <div className="tabs" role="tablist" aria-label="DO dashboard views">
              <button
                className={`tab ${view === "shipments" ? "active" : ""}`}
                id="do-tab-shipments"
                role="tab"
                aria-selected={view === "shipments"}
                aria-controls="do-panel-shipments"
                type="button"
                onClick={() => setView("shipments")}
              >
                Shipments
              </button>
              <button
                className={`tab ${view === "pids" ? "active" : ""}`}
                id="do-tab-pids"
                role="tab"
                aria-selected={view === "pids"}
                aria-controls="do-panel-pids"
                type="button"
                onClick={() => setView("pids")}
              >
                PID impact
              </button>
            </div>
            <span className="badge mono">
              Window {data.range.from} → {data.range.to}
            </span>
          </div>

          {view === "shipments" ? (
            <div className="stack" id="do-panel-shipments" role="tabpanel" aria-labelledby="do-tab-shipments">
              <section className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title"><Clock3 size={15} className="amber" /> Shipment aging by status</div>
                    <div className="card-subtitle">Current classification and DO-type scope</div>
                  </div>
                  <span className="badge">{visibleShipments.length} visible</span>
                </div>
                <AgingMatrix rows={visibleShipments} />
              </section>

              <section className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title"><Truck size={15} className="blue" /> All active shipments</div>
                    <div className="card-subtitle">{visibleShipments.length} of {classScopedShipments.length} in scope</div>
                  </div>
                  <button className="button small" type="button" onClick={exportShipments} disabled={visibleShipments.length === 0}>
                    <Download size={14} /> CSV
                  </button>
                </div>
                <div style={{ padding: "12px 17px", borderBottom: "1px solid var(--line)" }}>
                  <div className="card-subtitle" style={{ marginBottom: 9 }}>DO type</div>
                  <div className="filter-strip">
                    <button className={`filter-pill ${effectiveDoTypeFilter === "ALL" ? "active" : ""}`} type="button" onClick={() => setDoTypeFilter("ALL")}>
                      All types <span className="mono">{classScopedShipments.length}</span>
                    </button>
                    {doTypeOptions.map(([doType, count]) => (
                      <button
                        className={`filter-pill ${effectiveDoTypeFilter === doType ? "active" : ""}`}
                        type="button"
                        onClick={() => setDoTypeFilter(doType)}
                        key={doType}
                      >
                        {formatDoType(doType)} <span className="mono">{count}</span>
                      </button>
                    ))}
                    {unknownDoTypeCount > 0 && (
                      <button
                        className={`filter-pill ${effectiveDoTypeFilter === UNKNOWN_DO_TYPE ? "active" : ""}`}
                        type="button"
                        onClick={() => setDoTypeFilter(UNKNOWN_DO_TYPE)}
                      >
                        Unknown <span className="mono">{unknownDoTypeCount}</span>
                      </button>
                    )}
                  </div>
                </div>
                <div className="table-wrap" style={{ maxHeight: 510 }}>
                  <table aria-label="All active shipments" style={{ minWidth: 1_330 }}>
                    <thead>
                      <tr>
                        <th scope="col">Shipping ID</th>
                        <th scope="col">Status</th>
                        <th scope="col">Customer</th>
                        <th scope="col">DO #</th>
                        <th scope="col">PO #</th>
                        <th scope="col">DO type</th>
                        <th scope="col" className="right">Required</th>
                        <th scope="col" className="right">Picked</th>
                        <th scope="col" className="right">Pending</th>
                        <th scope="col" className="right">PIDs</th>
                        <th scope="col">Age</th>
                        <th scope="col" className="right">Completed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleShipments.length > 0 ? visibleShipments.map((shipment) => {
                        const expanded = expandedShipments.has(shipment.id);
                        return (
                          <Fragment key={shipment.id}>
                            <tr>
                              <td className="table-id" title={shipment.id}>{shipment.id}</td>
                              <td><span className={statusBadge(shipment.status)}>{formatStatus(shipment.status)}</span></td>
                              <td title={shipment.customer}>{shipment.customer}</td>
                              <td className="mono">{shipment.doNumber}</td>
                              <td className="mono" title={shipment.poNumber}>{shipment.poNumber}</td>
                              <td><span className={shipment.doType === "—" ? "badge" : "badge violet"}>{formatDoType(shipment.doType)}</span></td>
                              <td className="right mono blue">{formatNumber(shipment.required)}</td>
                              <td className="right mono teal">{formatNumber(shipment.picked)}</td>
                              <td className={`right mono ${shipment.pending > 0 ? "amber" : "dim"}`}>{formatNumber(shipment.pending)}</td>
                              <td className="right">
                                {shipment.pidDetails.length > 0 ? (
                                  <button
                                    className="button ghost small"
                                    type="button"
                                    aria-expanded={expanded}
                                    aria-label={`${expanded ? "Hide" : "Show"} ${shipment.pidCount} PIDs for ${shipment.id}`}
                                    onClick={() => toggleShipment(shipment.id)}
                                  >
                                    <span className="mono">{shipment.pidCount}</span>
                                    <ChevronDown size={13} style={{ transform: expanded ? "rotate(180deg)" : undefined, transition: "transform 150ms" }} />
                                  </button>
                                ) : <span className="dim">0</span>}
                              </td>
                              <td><span className={ageBadge(shipment.ageHours)}>{formatAge(shipment.ageHours)}</span></td>
                              <td className="right"><Completion picked={shipment.picked} required={shipment.required} /></td>
                            </tr>
                            {expanded && (
                              <tr>
                                <td colSpan={12} style={{ padding: 0, background: "var(--bg-soft)" }}>
                                  <div className="table-wrap" style={{ padding: "8px 18px 13px 42px" }}>
                                    <table aria-label={`PID detail for shipment ${shipment.id}`}>
                                      <thead>
                                        <tr>
                                          <th scope="col">Product ID</th>
                                          <th scope="col">Description</th>
                                          <th scope="col">Classification</th>
                                          <th scope="col" className="right">Required</th>
                                          <th scope="col" className="right">Picked</th>
                                          <th scope="col" className="right">Pending</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {shipment.pidDetails.map((pid, index) => (
                                          <tr key={`${pid.productId || "unknown"}-${index}`}>
                                            <td className="table-id">{pid.productId || "Unidentified"}</td>
                                            <td className="wrap" title={pid.description}>{pid.description || "—"}</td>
                                            <td><span className={classificationBadge(pid.classification)}>{pid.classification}</span></td>
                                            <td className="right mono blue">{formatNumber(pid.required)}</td>
                                            <td className="right mono teal">{formatNumber(pid.picked)}</td>
                                            <td className={`right mono ${pid.pending > 0 ? "rose" : "dim"}`}>{formatNumber(pid.pending)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      }) : (
                        <tr><td className="table-empty" colSpan={12}>No active shipments match the current filters.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          ) : (
            <div className="stack" id="do-panel-pids" role="tabpanel" aria-labelledby="do-tab-pids">
              <section className="metric-grid" aria-label="PID quantity summary">
                <MetricCard label="Required qty" value={formatNumber(pidTotals.required)} foot="total ordered" tone="violet" icon={<Boxes size={17} />} />
                <MetricCard label="Picked qty" value={formatNumber(pidTotals.picked)} foot="scanned and ready" tone="teal" icon={<PackageCheck size={17} />} />
                <MetricCard label="Pending qty" value={formatNumber(pidTotals.pending)} foot="still to pick" tone="amber" icon={<Clock3 size={17} />} />
                <MetricCard label="Impacted PIDs" value={formatNumber(filteredPids.length)} foot="unique products" tone="blue" icon={<Tags size={17} />} />
              </section>

              <section className="grid grid-2">
                <div className="card">
                  <div className="card-header">
                    <div className="card-title"><AlertTriangle size={15} className="rose" /> Top PIDs by pending qty</div>
                    <span className="badge bad">Top 10</span>
                  </div>
                  <PidRankingTable rows={topPendingPids} label="Top PIDs by pending quantity" />
                </div>
                <div className="card">
                  <div className="card-header">
                    <div className="card-title"><SearchCheck size={15} className="violet" /> Highest-impact PIDs</div>
                    <span className="badge violet">Top 10</span>
                  </div>
                  <PidRankingTable rows={highestImpactPids} label="Highest impact PIDs by shipment count" />
                </div>
              </section>

              <section className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title"><Tags size={15} className="violet" /> All PIDs</div>
                    <div className="card-subtitle">{filteredPids.length} products in scope</div>
                  </div>
                  <button className="button small" type="button" onClick={exportPids} disabled={filteredPids.length === 0}>
                    <Download size={14} /> CSV
                  </button>
                </div>
                <div className="table-wrap" style={{ maxHeight: 510 }}>
                  <table aria-label="All impacted PIDs" style={{ minWidth: 940 }}>
                    <thead>
                      <tr>
                        <th scope="col">PID</th>
                        <th scope="col">Description</th>
                        <th scope="col">Classification</th>
                        <th scope="col">HSN code</th>
                        <th scope="col" className="right">Required</th>
                        <th scope="col" className="right">Picked</th>
                        <th scope="col" className="right">Pending</th>
                        <th scope="col" className="right">Shipments</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPids.length > 0 ? filteredPids.map((pid) => (
                        <tr key={pid.pid}>
                          <td className="table-id">{pid.pid}</td>
                          <td className="wrap" title={pid.description}>{pid.description || "—"}</td>
                          <td><span className={classificationBadge(pid.classification)}>{pid.classification}</span></td>
                          <td className="mono">{pid.hsnCode || "—"}</td>
                          <td className="right mono blue">{formatNumber(pid.required)}</td>
                          <td className="right mono teal">{formatNumber(pid.picked)}</td>
                          <td className={`right mono ${pid.pending > 0 ? "amber" : "dim"}`}>{formatNumber(pid.pending)}</td>
                          <td className="right mono violet">{formatNumber(pid.shipmentCount)}</td>
                        </tr>
                      )) : (
                        <tr><td className="table-empty" colSpan={8}>No PIDs match the current classification filter.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}

          <details className="card">
            <summary className="card-header" style={{ cursor: "pointer", listStyle: "none" }}>
              <div>
                <div className="card-title"><SearchCheck size={15} className="teal" /> Fetch diagnostics</div>
                <div className="card-subtitle">Trace count changes from NexS to the visible dashboard</div>
              </div>
              <span className={data.warnings.length > 0 ? "badge warn" : "badge good"}>
                {data.warnings.length > 0 ? `${data.warnings.length} notice${data.warnings.length === 1 ? "" : "s"}` : "Complete"}
              </span>
            </summary>
            <div className="card-pad stack">
              <div className="metric-grid" style={{ marginBottom: 0 }}>
                <MetricCard label="NexS reported" value={data.summary.apiReportedTotal === null ? "—" : formatNumber(data.summary.apiReportedTotal)} foot="raw API total" tone="blue" icon={<SearchCheck size={16} />} />
                <MetricCard label="Fetched unique" value={formatNumber(data.summary.fetchedTotal)} foot={`${data.summary.duplicatesRemoved} duplicates removed`} tone="teal" icon={<Truck size={16} />} />
                <MetricCard label="Terminal excluded" value={formatNumber(data.summary.terminalExcluded + data.summary.terminalAfterDetail)} foot={`${data.summary.dispatched} dispatched/delivered`} tone="violet" icon={<PackageCheck size={16} />} />
                <MetricCard label="Detail gaps" value={formatNumber(data.summary.detailFailures)} foot="excluded from totals" tone={data.summary.detailFailures > 0 ? "rose" : "teal"} icon={<AlertTriangle size={16} />} />
                <MetricCard label="Blank units removed" value={formatNumber(data.summary.blankUnitsRemoved)} foot={`${data.summary.blankOnlyShipmentsHidden} blank-only shipments`} tone="amber" icon={<Boxes size={16} />} />
                <MetricCard label="Shown" value={formatNumber(data.summary.shownShipments)} foot={`${data.summary.impactedPids} impacted PIDs`} tone="blue" icon={<Tags size={16} />} />
              </div>
              <div className="divider" />
              <div className="toolbar" style={{ justifyContent: "space-between", fontSize: 10 }}>
                <span className="dim">Catalog cache: {data.summary.catalogCache.hit} hit · {data.summary.catalogCache.miss} miss · {data.summary.catalogCache.coalesced} coalesced</span>
                <span className="dim">Excluded classification: {data.configuration.excludedClassifications.join(", ")}</span>
              </div>
            </div>
          </details>
        </div>
      ) : null}
    </div>
  );
}
