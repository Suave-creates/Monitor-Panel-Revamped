"use client";

import { useEffect, useMemo, useState } from "react";
import { FileSpreadsheet } from "lucide-react";
import DispatchAgingMatrix from "./DispatchAgingMatrix";
import {
  activeBuckets,
  allItems,
  bandClass,
  bandHdrLabel,
  bandBuckets,
  DAY_COLS,
  dayTier,
  deptAllItems,
  DEPT_META,
  deptStageColumns,
  daysMatrixRows,
  healthFor,
  headerKpiItems,
  HOUR_COLS,
  hoursMatrixRows,
  stageDeptColumns,
  STAGE_META,
  STAGE_ORDER,
  toExportRow,
  type AgingStageFilter,
  type BucketDef,
  type DeptKey,
  type PendencyItem,
  type StageKey,
} from "../lib/dispatchAggregate";
import { downloadXlsxRows, timestamp, type DispatchCategoriesData } from "../types";

const DAY_LEGEND = [
  { tier: "good", label: "Good (0-1)" }, { tier: "watch", label: "Watch (2-3)" }, { tier: "delay", label: "Delay (4-5)" },
  { tier: "high", label: "High delay (6-7)" }, { tier: "crit", label: "Critical (7+ days)" },
];
const HOUR_LEGEND = [
  { tier: "good", label: "Fresh (0-1)" }, { tier: "watch", label: "Recent (1-2)" }, { tier: "delay", label: "Moderate (2-4)" },
  { tier: "high", label: "Stale (4-12)" }, { tier: "crit", label: "Very stale (12+ hrs)" },
];

const AGING_STAGE_KEY = "delay-dashboard.dispatch.agingStage.v1";
const SUMMARY_VIEW_KEY = "delay-dashboard.dispatch.summaryView.v1";

type Props = {
  categories: DispatchCategoriesData;
  buckets: Record<StageKey, BucketDef[]>;
  deptView: DeptKey[];
  onDrilldown: (title: string, subtitle: string, orders: PendencyItem[]) => void;
};

/** The Dispatch Report tab's own Report view — ported from the "Dispatch
 *  Pendency Tracker" extension's dispatch.js. Lives beside this module's
 *  own ReportView (delay data) and ShiftReportView, sharing the page
 *  shell's filter bar (Facility, NDD Only, JIT, International, Date
 *  Range, Auto-refresh) but with its own Categories selector and
 *  per-stage Hour Buckets, passed down from page.tsx. */
export default function DispatchReportView({ categories, buckets, deptView, onDrilldown }: Props) {
  const [agingStage, setAgingStage] = useState<AgingStageFilter>("ALL");
  const [summaryView, setSummaryView] = useState<"individual" | "board">("individual");

  useEffect(() => {
    // This effect intentionally hydrates client-only localStorage preferences after mount.
    try {
      const savedStage = localStorage.getItem(AGING_STAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (savedStage === "ALL" || savedStage === "PACKING" || savedStage === "MANIFEST" || savedStage === "RTS") setAgingStage(savedStage);
      const savedView = localStorage.getItem(SUMMARY_VIEW_KEY);
      if (savedView === "individual" || savedView === "board") setSummaryView(savedView);
    } catch { /* ignore */ }
  }, []);

  function changeAgingStage(v: AgingStageFilter) {
    setAgingStage(v);
    localStorage.setItem(AGING_STAGE_KEY, v);
  }
  function changeSummaryView(v: "individual" | "board") {
    setSummaryView(v);
    localStorage.setItem(SUMMARY_VIEW_KEY, v);
  }

  const kpis = useMemo(() => headerKpiItems(categories), [categories]);
  const dayCols = DAY_COLS.map((c) => ({ key: c, tier: dayTier(c) }));
  const hourCols = HOUR_COLS.map((c) => ({ key: c.key, tier: c.tier }));

  function downloadAll() {
    const orders = deptView.flatMap((d) => deptAllItems(categories, d));
    if (!orders.length) return;
    downloadXlsxRows(orders.map(toExportRow), `dispatch-report-all-orders-${timestamp()}.xlsx`, "All Orders");
  }

  return (
    <div className="stack">
      <div className="toolbar" style={{ justifyContent: "flex-end" }}>
        <span className="dim" style={{ fontSize: 10, marginRight: "auto" }}>Download every order currently in view, across all selected categories</span>
        <button type="button" className="button" onClick={downloadAll}><FileSpreadsheet size={13} /> Download all orders (XLSX)</button>
      </div>

      <div className="metric-grid">
        <button type="button" className="metric metric-click" onClick={() => onDrilldown("All orders", "In process", kpis.inProcess)}>
          <div className="metric-label">All orders</div><div className="metric-value">{kpis.inProcess.length.toLocaleString("en-IN")}</div><div className="metric-foot">In process</div>
        </button>
        <button type="button" className="metric metric-click rose" onClick={() => onDrilldown("Critical orders", "Dwell > 6 hours — need immediate action", kpis.crit)}>
          <div className="metric-label">Critical (&gt;6 Hr)</div><div className="metric-value">{kpis.crit.length.toLocaleString("en-IN")}</div><div className="metric-foot">Need immediate action</div>
        </button>
        <button type="button" className="metric metric-click violet" onClick={() => onDrilldown("At Ready To Ship", "Orders currently pending Ready To Ship", kpis.atRts)}>
          <div className="metric-label">At RTS</div><div className="metric-value">{kpis.atRts.length.toLocaleString("en-IN")}</div><div className="metric-foot">Pending Ready To Ship</div>
        </button>
        <button type="button" className="metric metric-click amber" onClick={() => onDrilldown(">2 Hr delayed orders", "Dwell > 2 hours, across selected categories", kpis.delay)}>
          <div className="metric-label">&gt;2 Hr delayed</div><div className="metric-value">{kpis.delay.length.toLocaleString("en-IN")}</div><div className="metric-foot">Across selected cats</div>
        </button>
      </div>

      <div className="grid grid-2">
        <div className="card card-pad">
          <div className="card-title" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <span>Orders aging (days)</span>
            <select className="select" style={{ marginLeft: "auto", width: "auto", height: 28, fontSize: 10 }} value={agingStage} onChange={(e) => changeAgingStage(e.target.value as AgingStageFilter)}>
              <option value="ALL">All stages</option>
              <option value="PACKING">Packing</option>
              <option value="MANIFEST">Manifest</option>
              <option value="RTS">Ready To Ship</option>
            </select>
          </div>
          <DispatchAgingMatrix columns={dayCols} rows={daysMatrixRows(categories, agingStage, deptView)} legend={DAY_LEGEND}
            onCellClick={(row, colIdx) => onDrilldown(`${DEPT_META[row.dept].name} — ${DAY_COLS[colIdx]} day${DAY_COLS[colIdx] === "1" ? "" : "s"} old`, "Orders aging", row.cells[colIdx])}
            onTotalClick={(row) => onDrilldown(`${DEPT_META[row.dept].name} — all orders`, "Orders aging", row.cells.flat())} />
        </div>
        <div className="card card-pad">
          <div className="card-title" style={{ marginBottom: 10 }}>Last-update aging (hours)</div>
          <DispatchAgingMatrix columns={hourCols} rows={hoursMatrixRows(categories, agingStage, deptView)} legend={HOUR_LEGEND}
            onCellClick={(row, colIdx) => onDrilldown(`${DEPT_META[row.dept].name} — ${hourCols[colIdx].key} hrs since update`, "Last-update aging", row.cells[colIdx])}
            onTotalClick={(row) => onDrilldown(`${DEPT_META[row.dept].name} — all orders`, "Last-update aging", row.cells.flat())} />
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-title" style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <span>Dispatch summary</span>
          <div className="tabs" style={{ marginLeft: "auto" }}>
            <button type="button" className={`tab${summaryView === "individual" ? " active" : ""}`} onClick={() => changeSummaryView("individual")}>Individual</button>
            <button type="button" className={`tab${summaryView === "board" ? " active" : ""}`} onClick={() => changeSummaryView("board")}>Board</button>
          </div>
        </div>
        {summaryView === "individual" ? (
          <IndividualView categories={categories} deptView={deptView} buckets={buckets} onDrilldown={onDrilldown} />
        ) : (
          <BoardView categories={categories} buckets={buckets} onDrilldown={onDrilldown} />
        )}
      </div>
    </div>
  );
}

type SummaryProps = {
  categories: DispatchCategoriesData;
  buckets: Record<StageKey, BucketDef[]>;
  onDrilldown: (title: string, subtitle: string, orders: PendencyItem[]) => void;
};

function IndividualView({ categories, deptView, buckets, onDrilldown }: SummaryProps & { deptView: DeptKey[] }) {
  return (
    <div className="dl-dept-grid">
      {deptView.map((dept) => {
        const items = deptAllItems(categories, dept);
        const health = healthFor(items);
        const cols = deptStageColumns(categories, dept);
        const meta = DEPT_META[dept];
        const tot = Math.max(1, health.total);
        return (
          <div key={dept} className="dl-dept">
            <div className="dl-dept-hd">
              <span className="dl-dept-ico">{meta.ico}</span>
              <span className="dl-dept-name">{meta.name}</span>
              <span className={`dl-badge dl-badge-${health.badge}`}>{health.label}</span>
              <button type="button" className="dl-dept-total dl-link" onClick={() => onDrilldown(`${meta.name} — all orders`, meta.sub, items)}>
                Total <b>{health.total.toLocaleString("en-IN")}</b>
              </button>
            </div>
            <div className={cols.length > 4 ? "dl-dcols dl-dcols-grid" : "dl-dcols"}>
              {cols.map((c) => (
                <MiniColumn key={c.key} label={c.label} list={c.list} defs={activeBuckets(buckets[c.key as StageKey])}
                  onHeaderClick={() => onDrilldown(`${meta.name} — ${c.label}`, meta.sub, c.list)}
                  onBandClick={(band) => onDrilldown(`${meta.name} — ${c.label} ${bandHdrLabel(band.def)}`, meta.sub, band.list)} />
              ))}
            </div>
            <RagBar health={health} tot={tot} />
          </div>
        );
      })}
    </div>
  );
}

function BoardView({ categories, buckets, onDrilldown }: SummaryProps) {
  return (
    <div className="dl-dept-grid">
      {STAGE_ORDER.map((stage) => {
        const items = allItems(categories).filter((o) => o.stage === stage);
        const health = healthFor(items);
        const cols = stageDeptColumns(categories, stage);
        const meta = STAGE_META[stage];
        const tot = Math.max(1, health.total);
        return (
          <div key={stage} className="dl-dept">
            <div className="dl-dept-hd">
              <span className="dl-dept-ico">{meta.ico}</span>
              <span className="dl-dept-name">{meta.label}</span>
              <span className={`dl-badge dl-badge-${health.badge}`}>{health.label}</span>
              <button type="button" className="dl-dept-total dl-link" onClick={() => onDrilldown(`${meta.label} — all categories`, "Pending across every category", items)}>
                Total <b>{health.total.toLocaleString("en-IN")}</b>
              </button>
            </div>
            <div className={cols.length > 4 ? "dl-dcols dl-dcols-grid" : "dl-dcols"}>
              {cols.map((c) => (
                <MiniColumn key={c.key} label={c.label} list={c.list} defs={activeBuckets(buckets[stage])}
                  onHeaderClick={() => onDrilldown(`${meta.label} — ${c.label}`, "Pending across every category", c.list)}
                  onBandClick={(band) => onDrilldown(`${meta.label} — ${c.label} ${bandHdrLabel(band.def)}`, "Pending across every category", band.list)} />
              ))}
            </div>
            <RagBar health={health} tot={tot} />
          </div>
        );
      })}
    </div>
  );
}

function MiniColumn({ label, list, defs, onHeaderClick, onBandClick }: {
  label: string; list: PendencyItem[]; defs: Exclude<BucketDef, null>[];
  onHeaderClick: () => void; onBandClick: (band: { def: Exclude<BucketDef, null>; list: PendencyItem[] }) => void;
}) {
  const bands = bandBuckets(list, defs);
  return (
    <div className="dl-dcol">
      <button type="button" className="dl-dcol-h dl-link" onClick={onHeaderClick}>
        {label} <span className="dim">({list.length.toLocaleString("en-IN")})</span>
      </button>
      <div className="dl-dcol-bands">{defs.map((d, i) => <span key={i}>{bandHdrLabel(d)}</span>)}</div>
      <div className="dl-dcol-vals">
        {bands.map((band, i) => {
          const n = band ? band.list.length : null;
          return (
            <button
              type="button"
              key={i}
              className={`dl-band-btn ${bandClass(i, n)}`}
              disabled={!band || !band.list.length}
              onClick={() => band && onBandClick(band)}
            >
              {n == null || n === 0 ? "–" : n}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RagBar({ health, tot }: { health: ReturnType<typeof healthFor>; tot: number }) {
  return (
    <div className="dl-bar">
      <i className="seg-ok" style={{ width: `${Math.round((health.okN / tot) * 100)}%` }} />
      <i className="seg-warn" style={{ width: `${Math.round((health.warnN / tot) * 100)}%` }} />
      <i className="seg-crit" style={{ width: `${Math.round((health.critN / tot) * 100)}%` }} />
    </div>
  );
}
