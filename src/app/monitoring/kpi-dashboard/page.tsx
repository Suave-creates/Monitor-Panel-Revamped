"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Download,
  Gauge as GaugeIcon,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

type Facility = "NXS1" | "NXS2";
type OrderMode = "njit" | "jit";
type GaugeKey = "d1" | "d2" | "ndd";
type CacheMeta = { status: "hit" | "miss" | "coalesced"; ageMs: number; ttlMs: number };
type DetailRow = Record<string, unknown>;

type GaugeData = {
  key: GaugeKey;
  label: string;
  sublabel: string;
  day: string;
  mode: OrderMode;
  target: number;
  denominator: number | null;
  open: number;
  readyToShip: number;
  remaining: number;
  completion: number | null;
  ordersToTarget: number | null;
  stages: Array<{ stage: string; count: number; percentOfDay: number | null }>;
  reportAsOn: string | null;
  frTag: string;
  frFound: boolean;
};

type DashboardData = {
  facility: Facility;
  mode: OrderMode;
  generatedAt: string;
  gauges: GaugeData[];
  infocorner: {
    available: boolean;
    error: string | null;
    dates: Record<string, unknown>;
    cache: CacheMeta | null;
  };
};

type DashboardEnvelope = { ok: true; data: DashboardData; cache: CacheMeta };
type ErrorEnvelope = { ok?: false; error?: string };
type DetailEnvelope = {
  ok: true;
  data: { rows: DetailRow[]; total: number; truncated: boolean };
  cache: CacheMeta;
};

function numberText(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function reportTime(value: string | null): string {
  if (!value) return "Live response";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "object") text = JSON.stringify(value);
  else text = String(value);
  if (/^[=+\-@]/.test(text.trimStart())) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(rows: DetailRow[], filename: string): void {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const csv = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

export default function KpiDashboardPage() {
  const [facility, setFacility] = useState<Facility>("NXS1");
  const [mode, setMode] = useState<OrderMode>("njit");
  const [includeNdd, setIncludeNdd] = useState(false);
  const [refreshSec, setRefreshSec] = useState(60);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [cache, setCache] = useState<CacheMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async (force = false) => {
    const sequence = ++requestSequence.current;
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/monitoring/kpi-dashboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "dashboard", facility, mode, includeNdd, force }),
      });
      const payload = await response.json() as DashboardEnvelope | ErrorEnvelope;
      if (!response.ok || payload.ok !== true) {
        throw new Error("error" in payload && payload.error ? payload.error : `Request failed (${response.status})`);
      }
      if (sequence === requestSequence.current) {
        setDashboard(payload.data);
        setCache(payload.cache);
      }
    } catch (loadError) {
      if (sequence === requestSequence.current) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [facility, mode, includeNdd]);

  useEffect(() => {
    // This effect intentionally synchronizes the selected controls with server data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(false);
  }, [load]);

  useEffect(() => {
    if (refreshSec <= 0) return;
    const timer = window.setInterval(() => void load(false), refreshSec * 1_000);
    return () => window.clearInterval(timer);
  }, [load, refreshSec]);

  const exportStage = async (gauge: GaugeData, stage: string) => {
    const exportKey = `${gauge.key}:${stage}`;
    setExporting(exportKey);
    setError(null);
    try {
      const response = await fetch("/api/monitoring/kpi-dashboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "details",
          facility,
          mode,
          gauge: gauge.key,
          day: gauge.day,
          stage,
        }),
      });
      const payload = await response.json() as DetailEnvelope | ErrorEnvelope;
      if (!response.ok || payload.ok !== true) {
        throw new Error("error" in payload && payload.error ? payload.error : `Export failed (${response.status})`);
      }
      if (!payload.data.rows.length) throw new Error(`No detail rows were returned for ${stage}.`);
      downloadCsv(
        payload.data.rows,
        `${facility}_${gauge.key.toUpperCase()}_${safeName(stage)}_${gauge.day}.csv`,
      );
      if (payload.data.truncated) {
        setError(`The ${stage} export reached the safety row limit for at least one FR tag.`);
      }
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Monitoring · KPI dashboard</div>
          <h1>KPI Dashboard</h1>
          <p className="lede">
            Live D1, D2 (and optionally NDD) completion against infocorner volume, with the remaining work traced to each department.
          </p>
        </div>
        <div className="toolbar">
          <span className={`badge ${dashboard?.infocorner.available ? "good" : "warn"}`}>
            <span className="live-dot" /> {dashboard?.infocorner.available ? "Denominator linked" : "Waiting for infocorner"}
          </span>
          <button className="button" type="button" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? "spinner" : undefined} />
            {refreshing ? "Refreshing" : "Refresh now"}
          </button>
        </div>
      </div>

      <section className="card card-pad" aria-label="Dashboard controls">
        <div className="form-grid">
          <label className="field">
            <span className="label">Facility</span>
            <select className="select" value={facility} onChange={(event) => setFacility(event.target.value as Facility)}>
              <option value="NXS1">NXS1 · Bhiwadi</option>
              <option value="NXS2">NXS2 · Manesar</option>
            </select>
          </label>
          <div className="field">
            <span className="label">D1 / D2 order stream</span>
            <div className="tabs" role="group" aria-label="Order stream">
              <button className={`tab ${mode === "njit" ? "active" : ""}`} type="button" onClick={() => setMode("njit")}>NJIT</button>
              <button className={`tab ${mode === "jit" ? "active" : ""}`} type="button" onClick={() => setMode("jit")}>JIT</button>
            </div>
          </div>
          <div className="field">
            <span className="label">NDD gauge</span>
            <div className="tabs" role="group" aria-label="NDD gauge visibility">
              <button className={`tab ${includeNdd ? "active" : ""}`} type="button" onClick={() => setIncludeNdd(true)}>Show</button>
              <button className={`tab ${!includeNdd ? "active" : ""}`} type="button" onClick={() => setIncludeNdd(false)}>Hide</button>
            </div>
          </div>
          <label className="field">
            <span className="label">Auto refresh</span>
            <select className="select" value={refreshSec} onChange={(event) => setRefreshSec(Number(event.target.value))}>
              <option value={30}>Every 30 seconds</option>
              <option value={60}>Every 60 seconds</option>
              <option value={120}>Every 2 minutes</option>
              <option value={300}>Every 5 minutes</option>
              <option value={0}>Off</option>
            </select>
          </label>
          <div className="field">
            <span className="label">Response state</span>
            <div className="input mono" style={{ display: "flex", alignItems: "center" }}>
              {cache ? `${cache.status} · ${Math.round(cache.ageMs / 1_000)}s old` : "Not loaded"}
            </div>
          </div>
        </div>
        <p className="dim mono" style={{ margin: "12px 0 0", fontSize: 10 }}>
          NDD remains NJIT priority 1 and is optional. D1/D2 sum FR1+FR2, NDD (when shown) sums every FR tag, and Ready to Ship is excluded from remaining work.
        </p>
      </section>

      {error && (
        <div className="alert error section-gap" role="alert">
          <AlertTriangle size={16} /> <span>{error}</span>
        </div>
      )}

      {dashboard?.infocorner.error && (
        <div className="alert warning section-gap">
          <AlertTriangle size={16} />
          <span>Live open counts loaded, but completion percentages need infocorner: {dashboard.infocorner.error}</span>
        </div>
      )}

      {loading && !dashboard ? (
        <section className="card empty section-gap">
          <div><div className="spinner" style={{ margin: "0 auto 12px" }} /><strong>Loading live KPI dashboard</strong><span>Reading the active date windows and the facility denominator.</span></div>
        </section>
      ) : dashboard ? (
        <>
          <section className={`grid ${dashboard.gauges.length >= 3 ? "grid-3" : "grid-2"} section-gap`} aria-label="Completion gauges">
            {dashboard.gauges.map((gauge) => {
              const percent = gauge.completion ?? 0;
              const tone = gauge.key === "d2" ? "var(--amber)" : gauge.key === "ndd" ? "var(--violet)" : "var(--teal)";
              return (
                <article className="card card-pad" key={gauge.key}>
                  <div className="toolbar" style={{ justifyContent: "space-between" }}>
                    <div>
                      <div className="eyebrow" style={{ color: tone }}>{gauge.label}</div>
                      <h2>{gauge.sublabel}</h2>
                      <span className="dim mono" style={{ fontSize: 10 }}>{dayLabel(gauge.day)} · {gauge.mode.toUpperCase()}</span>
                    </div>
                    <span className={`badge ${gauge.frFound ? "good" : "bad"}`}>{gauge.frTag}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "118px minmax(0, 1fr)", gap: 18, alignItems: "center", marginTop: 17 }}>
                    <div
                      aria-label={`${gauge.label} completion ${numberText(gauge.completion, 1)} percent`}
                      style={{ width: 112, height: 112, padding: 7, borderRadius: "50%", background: `conic-gradient(${tone} ${percent * 3.6}deg, var(--surface-3) 0deg)` }}
                    >
                      <div style={{ width: "100%", height: "100%", borderRadius: "50%", background: "var(--surface)", display: "grid", placeItems: "center", textAlign: "center" }}>
                        <div><strong className="mono" style={{ display: "block", fontSize: 23 }}>{numberText(gauge.completion, 1)}{gauge.completion === null ? "" : "%"}</strong><span className="dim mono" style={{ fontSize: 9 }}>completion</span></div>
                      </div>
                    </div>
                    <div className="stack" style={{ gap: 8 }}>
                      <div><span className="label">Remaining</span><div className="mono" style={{ fontSize: 22, marginTop: 4 }}>{numberText(gauge.remaining)}</div></div>
                      <div className="toolbar"><span className="badge warn">Target {gauge.target}%</span><span className="badge good">{gauge.ordersToTarget === 0 ? "Target met" : `${numberText(gauge.ordersToTarget)} to target`}</span></div>
                    </div>
                  </div>
                  <div className="divider" style={{ margin: "17px 0 12px" }} />
                  <div className="grid grid-3" style={{ gap: 8 }}>
                    <div><span className="label">Open</span><div className="mono" style={{ marginTop: 5 }}>{numberText(gauge.open)}</div></div>
                    <div><span className="label">Ready to ship</span><div className="mono" style={{ marginTop: 5 }}>{numberText(gauge.readyToShip)}</div></div>
                    <div><span className="label">Day volume</span><div className="mono" style={{ marginTop: 5 }}>{numberText(gauge.denominator)}</div></div>
                  </div>
                  <p className="dim mono" style={{ margin: "13px 0 0", fontSize: 9 }}>{reportTime(gauge.reportAsOn)}</p>
                </article>
              );
            })}
          </section>

          <div className="page-head section-gap" style={{ marginTop: 28 }}>
            <div><div className="eyebrow">Remaining work</div><h2>Where orders are stuck</h2></div>
            <span className="badge info"><Activity size={12} /> Select a row for its full CSV</span>
          </div>

          <section className={`grid ${dashboard.gauges.length >= 3 ? "grid-3" : "grid-2"}`} aria-label="Department stage breakdown">
            {dashboard.gauges.map((gauge) => {
              const max = Math.max(1, ...gauge.stages.map((stage) => stage.count));
              return (
                <article className="card" key={`${gauge.key}-stages`}>
                  <div className="card-header">
                    <div><div className="card-title"><GaugeIcon size={14} /> {gauge.label} stages</div><div className="card-subtitle">{numberText(gauge.remaining)} remaining · {dayLabel(gauge.day)}</div></div>
                    <span className="badge">{gauge.stages.length} depts</span>
                  </div>
                  {gauge.stages.length ? (
                    <div className="stack" style={{ padding: 13, gap: 8 }}>
                      {gauge.stages.map((stage) => {
                        const key = `${gauge.key}:${stage.stage}`;
                        return (
                          <button
                            className="button ghost"
                            type="button"
                            key={stage.stage}
                            onClick={() => void exportStage(gauge, stage.stage)}
                            disabled={exporting !== null}
                            title={`Download ${stage.stage} details`}
                            style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 70px 40px 18px", width: "100%", padding: "9px 6px", textAlign: "left" }}
                          >
                            <span style={{ minWidth: 0 }}><span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stage.stage.replace(/:::/g, " · ")}</span><span className="progress" style={{ display: "block", marginTop: 6 }}><span style={{ width: `${(stage.count / max) * 100}%` }} /></span></span>
                            <span className="right mono">{stage.percentOfDay === null ? "—" : `${numberText(stage.percentOfDay, 1)}%`}</span>
                            <strong className="right mono">{numberText(stage.count)}</strong>
                            {exporting === key ? <span className="spinner" /> : <Download size={13} />}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="empty" style={{ minHeight: 170 }}><div><ShieldCheck size={22} /><strong>No remaining departments</strong><span>This day has no non-RTS work in the active FR scope.</span></div></div>
                  )}
                </article>
              );
            })}
          </section>
        </>
      ) : (
        <section className="card empty section-gap"><div><AlertTriangle size={24} /><strong>Dashboard unavailable</strong><span>Refresh after NexS authentication and network access are available.</span></div></section>
      )}
    </div>
  );
}
