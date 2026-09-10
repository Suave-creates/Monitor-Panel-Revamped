"use client";

import { useMemo } from "react";
import { FileSpreadsheet } from "lucide-react";
import ClAgingMatrix from "./ClAgingMatrix";
import {
  activeBuckets,
  allItems,
  bandClass,
  bandHdrLabel,
  bandBuckets,
  DAY_COLS,
  dayTier,
  daysMatrixRows,
  healthFor,
  headerKpiItems,
  HOUR_COLS,
  hoursMatrixRows,
  stageAllItems,
  stageDeptColumns,
  STAGE_META,
  STAGE_ORDER,
  toExportRow,
  type BucketDef,
  type PendencyItem,
  type StageKey,
  type TagFilter,
  type ViewMode,
} from "../lib/clAggregate";
import { downloadXlsxRows, timestamp, type DispatchCategoriesData } from "../types";

const DAY_LEGEND = [
  { tier: "good", label: "Good (0-1)" }, { tier: "watch", label: "Watch (2-3)" }, { tier: "delay", label: "Delay (4-5)" },
  { tier: "high", label: "High delay (6-7)" }, { tier: "crit", label: "Critical (7+ days)" },
];
const HOUR_LEGEND = [
  { tier: "good", label: "Fresh (0-1)" }, { tier: "watch", label: "Recent (1-2)" }, { tier: "delay", label: "Moderate (2-4)" },
  { tier: "high", label: "Stale (4-12)" }, { tier: "crit", label: "Very stale (12+ hrs)" },
];

type Props = {
  categories: DispatchCategoriesData;
  buckets: Record<StageKey, BucketDef[]>;
  tagFilter: TagFilter;
  viewMode: ViewMode;
  onDrilldown: (title: string, subtitle: string, orders: PendencyItem[]) => void;
};

/** The CL Report tab's own Report view. Stages (Synced, Pending
 *  Picking, In Picking, Order QC, Packing, Manifest, Shipment Not
 *  Generated, plus CL-FR0's two QC-Fail rework sub-buckets) are the
 *  primary axis — one row per stage in both aging matrices, one card
 *  per stage in the summary panel — with CL-FR0 / Bulk (CL/CLS) as a
 *  narrowing filter (`tagFilter`, owned by page.tsx, same role as
 *  Delay Report's FR Tag filter) rather than a second card axis. */
export default function ClReportView({ categories, buckets, tagFilter, viewMode, onDrilldown }: Props) {
  const kpis = useMemo(() => headerKpiItems(categories, tagFilter, viewMode), [categories, tagFilter, viewMode]);
  const dayCols = DAY_COLS.map((c) => ({ key: c, tier: dayTier(c) }));
  const hourCols = HOUR_COLS.map((c) => ({ key: c.key, tier: c.tier }));

  function downloadAll() {
    const orders = allItems(categories, tagFilter, viewMode);
    if (!orders.length) return;
    downloadXlsxRows(orders.map(toExportRow), `cl-report-all-orders-${timestamp()}.xlsx`, "All Orders");
  }

  return (
    <div className="stack">
      <div className="toolbar" style={{ justifyContent: "flex-end" }}>
        <span className="dim" style={{ fontSize: 10, marginRight: "auto" }}>Download every order currently in view</span>
        <button type="button" className="button" onClick={downloadAll}><FileSpreadsheet size={13} /> Download all orders (XLSX)</button>
      </div>

      <div className="metric-grid">
        <button type="button" className="metric metric-click" onClick={() => onDrilldown("All orders", "In process", kpis.inProcess)}>
          <div className="metric-label">All orders</div><div className="metric-value">{kpis.inProcess.length.toLocaleString("en-IN")}</div><div className="metric-foot">In process</div>
        </button>
        <button type="button" className="metric metric-click rose" onClick={() => onDrilldown("Critical orders", "Dwell > 6 hours — need immediate action", kpis.crit)}>
          <div className="metric-label">Critical (&gt;6 Hr)</div><div className="metric-value">{kpis.crit.length.toLocaleString("en-IN")}</div><div className="metric-foot">Need immediate action</div>
        </button>
        <button type="button" className="metric metric-click violet" onClick={() => onDrilldown("At Manifest", "Orders currently at Manifest", kpis.atManifest)}>
          <div className="metric-label">At Manifest</div><div className="metric-value">{kpis.atManifest.length.toLocaleString("en-IN")}</div><div className="metric-foot">Pending Manifest</div>
        </button>
        <button type="button" className="metric metric-click amber" onClick={() => onDrilldown(">2 Hr delayed orders", "Dwell > 2 hours", kpis.delay)}>
          <div className="metric-label">&gt;2 Hr delayed</div><div className="metric-value">{kpis.delay.length.toLocaleString("en-IN")}</div><div className="metric-foot">Across selected stages</div>
        </button>
      </div>

      <div className="grid grid-2">
        <div className="card card-pad">
          <div className="card-title" style={{ marginBottom: 10 }}>Orders aging (days)</div>
          <ClAgingMatrix columns={dayCols} rows={daysMatrixRows(categories, tagFilter, viewMode)} legend={DAY_LEGEND}
            onCellClick={(row, colIdx) => onDrilldown(`${STAGE_META[row.stage].label} — ${DAY_COLS[colIdx]} day${DAY_COLS[colIdx] === "1" ? "" : "s"} old`, "Orders aging", row.cells[colIdx])}
            onTotalClick={(row) => onDrilldown(`${STAGE_META[row.stage].label} — all orders`, "Orders aging", row.cells.flat())} />
        </div>
        <div className="card card-pad">
          <div className="card-title" style={{ marginBottom: 10 }}>Last-update aging (hours)</div>
          <ClAgingMatrix columns={hourCols} rows={hoursMatrixRows(categories, tagFilter, viewMode)} legend={HOUR_LEGEND}
            onCellClick={(row, colIdx) => onDrilldown(`${STAGE_META[row.stage].label} — ${hourCols[colIdx].key} hrs since update`, "Last-update aging", row.cells[colIdx])}
            onTotalClick={(row) => onDrilldown(`${STAGE_META[row.stage].label} — all orders`, "Last-update aging", row.cells.flat())} />
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-title" style={{ marginBottom: 12 }}>CL summary</div>
        <div className="dl-dept-grid">
          {STAGE_ORDER.map((stage) => {
            const items = stageAllItems(categories, stage, tagFilter, viewMode);
            const health = healthFor(items);
            const cols = stageDeptColumns(categories, stage, tagFilter, viewMode);
            const meta = STAGE_META[stage];
            const tot = Math.max(1, health.total);
            if (!cols.length) return null;
            return (
              <div key={stage} className="dl-dept">
                <div className="dl-dept-hd">
                  <span className="dl-dept-ico">{meta.ico}</span>
                  <span className="dl-dept-name">{meta.label}</span>
                  <span className={`dl-badge dl-badge-${health.badge}`}>{health.label}</span>
                  <button type="button" className="dl-dept-total dl-link" onClick={() => onDrilldown(`${meta.label} — all orders`, "CL summary", items)}>
                    Total <b>{health.total.toLocaleString("en-IN")}</b>
                  </button>
                </div>
                <div className={cols.length > 4 ? "dl-dcols dl-dcols-grid" : "dl-dcols"}>
                  {cols.map((c) => (
                    <MiniColumn key={c.key} label={c.label} list={c.list} defs={activeBuckets(buckets[stage])}
                      onHeaderClick={() => onDrilldown(`${meta.label} — ${c.label}`, "CL summary", c.list)}
                      onBandClick={(band) => onDrilldown(`${meta.label} — ${c.label} ${bandHdrLabel(band.def)}`, "CL summary", band.list)} />
                  ))}
                </div>
                <RagBar health={health} tot={tot} />
              </div>
            );
          })}
        </div>
      </div>
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
