"use client";

import { useMemo } from "react";
import { FileSpreadsheet } from "lucide-react";
import AgingMatrix from "./AgingMatrix";
import {
  activeBuckets,
  bandClass,
  bandHdrLabel,
  bandBuckets,
  DAY_COLS,
  dayTier,
  DEPT_META,
  daysMatrixRows,
  deptColumns,
  deptHealth,
  deptOrdersMap,
  filterByLensType,
  headerKpiOrders,
  HOUR_COLS,
  hoursMatrixRows,
  toExportRow,
  type AgingItem,
  type BucketDef,
  type DeptKey,
} from "../lib/aggregate";
import type { LensTypeFilter, PidSets } from "../lib/pidClassify";
import { downloadXlsxRows, timestamp, type QcfailOrder, type StagesData, type TaggedOrder } from "../types";

const DAY_LEGEND = [
  { tier: "good", label: "Good (0-1)" }, { tier: "watch", label: "Watch (2-3)" }, { tier: "delay", label: "Delay (4-5)" },
  { tier: "high", label: "High delay (6-7)" }, { tier: "crit", label: "Critical (7+ days)" },
];
const HOUR_LEGEND = [
  { tier: "good", label: "Fresh (0-1)" }, { tier: "watch", label: "Recent (1-2)" }, { tier: "delay", label: "Moderate (2-4)" },
  { tier: "high", label: "Stale (4-12)" }, { tier: "crit", label: "Very stale (12+ hrs)" },
];

type Props = {
  stages: StagesData;
  qcfailOrders: QcfailOrder[];
  warehouseOrders: TaggedOrder[];
  packingOrders: TaggedOrder[];
  buckets: Record<DeptKey, BucketDef[]>;
  deptView: DeptKey[];
  pidSets: PidSets;
  lensTypeFilter: LensTypeFilter;
  onDrilldown: (title: string, subtitle: string, orders: AgingItem[]) => void;
};

export default function ReportView({ stages, qcfailOrders, warehouseOrders, packingOrders, buckets, deptView, pidSets, lensTypeFilter, onDrilldown }: Props) {
  const deptOrders = useMemo(() => {
    const all = deptOrdersMap(stages, qcfailOrders, warehouseOrders, packingOrders, pidSets);
    const out = {} as Record<DeptKey, AgingItem[]>;
    (Object.keys(all) as DeptKey[]).forEach((dept) => { out[dept] = filterByLensType(all[dept], lensTypeFilter); });
    return out;
  }, [stages, qcfailOrders, warehouseOrders, packingOrders, pidSets, lensTypeFilter]);
  const kpis = useMemo(() => headerKpiOrders(deptOrders, deptView), [deptOrders, deptView]);
  const dayCols = DAY_COLS.map((c) => ({ key: c, tier: dayTier(c) }));
  const hourCols = HOUR_COLS.map((c) => ({ key: c.key, tier: c.tier }));

  function downloadAll() {
    const orders = deptView.flatMap((d) => deptOrders[d] || []);
    if (!orders.length) return;
    downloadXlsxRows(orders.map(toExportRow), `delay-dashboard-all-orders-${timestamp()}.xlsx`, "All Orders");
  }

  return (
    <div className="stack">
      <div className="toolbar" style={{ justifyContent: "flex-end" }}>
        <span className="dim" style={{ fontSize: 10, marginRight: "auto" }}>Download every order currently in view, across all selected departments</span>
        <button type="button" className="button" onClick={downloadAll}><FileSpreadsheet size={13} /> Download all orders (XLSX)</button>
      </div>

      <div className="metric-grid">
        <button type="button" className="metric metric-click" onClick={() => onDrilldown("All orders", "In process", kpis.inProcess)}>
          <div className="metric-label">All orders</div><div className="metric-value">{kpis.inProcess.length.toLocaleString("en-IN")}</div><div className="metric-foot">In process</div>
        </button>
        <button type="button" className="metric metric-click rose" onClick={() => onDrilldown("Critical orders", "Dwell > 6 hours — need immediate action", kpis.crit)}>
          <div className="metric-label">Critical (&gt;6 Hr)</div><div className="metric-value">{kpis.crit.length.toLocaleString("en-IN")}</div><div className="metric-foot">Need immediate action</div>
        </button>
        <button type="button" className="metric metric-click violet" onClick={() => onDrilldown("QC hold orders", "Orders currently in QC hold", kpis.qcHold)}>
          <div className="metric-label">QC hold</div><div className="metric-value">{kpis.qcHold.length.toLocaleString("en-IN")}</div><div className="metric-foot">Orders in QC hold</div>
        </button>
        <button type="button" className="metric metric-click amber" onClick={() => onDrilldown(">2 Hr delayed orders", "Dwell > 2 hours, across selected departments", kpis.delay)}>
          <div className="metric-label">&gt;2 Hr delayed</div><div className="metric-value">{kpis.delay.length.toLocaleString("en-IN")}</div><div className="metric-foot">Across selected depts</div>
        </button>
      </div>

      <div className="grid grid-2">
        <div className="card card-pad">
          <div className="card-title" style={{ marginBottom: 10 }}>Orders aging (days)</div>
          <AgingMatrix columns={dayCols} rows={daysMatrixRows(deptOrders, deptView)} legend={DAY_LEGEND}
            onCellClick={(row, colIdx) => onDrilldown(`${DEPT_META[row.dept].name} — ${DAY_COLS[colIdx]} day${DAY_COLS[colIdx] === "1" ? "" : "s"} old`, "Orders aging", row.cells[colIdx])}
            onTotalClick={(row) => onDrilldown(`${DEPT_META[row.dept].name} — all orders`, "Orders aging", row.cells.flat())} />
        </div>
        <div className="card card-pad">
          <div className="card-title" style={{ marginBottom: 10 }}>Last-update aging (hours)</div>
          <AgingMatrix columns={hourCols} rows={hoursMatrixRows(deptOrders, deptView)} legend={HOUR_LEGEND}
            onCellClick={(row, colIdx) => onDrilldown(`${DEPT_META[row.dept].name} — ${hourCols[colIdx].key} hrs since update`, "Last-update aging", row.cells[colIdx])}
            onTotalClick={(row) => onDrilldown(`${DEPT_META[row.dept].name} — all orders`, "Last-update aging", row.cells.flat())} />
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-title" style={{ marginBottom: 12 }}>Department summary</div>
        <div className="dl-dept-grid">
          {deptView.map((dept) => {
            const items = deptOrders[dept] || [];
            const dHealth = deptHealth(items);
            const cols = deptColumns(dept, deptOrders);
            const defs = activeBuckets(buckets[dept]);
            const tot = Math.max(1, dHealth.total);
            const meta = DEPT_META[dept];
            return (
              <div key={dept} className="dl-dept">
                <div className="dl-dept-hd">
                  <span className="dl-dept-ico">{meta.ico}</span>
                  <span className="dl-dept-name">{meta.name}</span>
                  <span className={`dl-badge dl-badge-${dHealth.badge}`}>{dHealth.label}</span>
                  <button type="button" className="dl-dept-total dl-link" onClick={() => onDrilldown(`${meta.name} — all orders`, "Department summary", items)}>
                    Total <b>{dHealth.total.toLocaleString("en-IN")}</b>
                  </button>
                </div>
                <div className={cols.length > 4 ? "dl-dcols dl-dcols-grid" : "dl-dcols"}>
                  {cols.map((c) => {
                    const b = bandBuckets(c.list, defs);
                    return (
                      <div key={c.label} className="dl-dcol">
                        <button type="button" className="dl-dcol-h dl-link" onClick={() => onDrilldown(`${meta.name} — ${c.label}`, "Department summary", c.list)}>
                          {c.label} <span className="dim">({c.list.length.toLocaleString("en-IN")})</span>
                        </button>
                        <div className="dl-dcol-bands">{defs.map((d, i) => <span key={i}>{bandHdrLabel(d)}</span>)}</div>
                        <div className="dl-dcol-vals">
                          {b.map((band, i) => {
                            const n = band ? band.list.length : null;
                            return (
                              <button
                                type="button"
                                key={i}
                                className={`dl-band-btn ${bandClass(i, n)}`}
                                disabled={!band || !band.list.length}
                                onClick={() => band && onDrilldown(`${meta.name} — ${c.label} ${bandHdrLabel(band.def)}`, "Department summary", band.list)}
                              >
                                {n == null || n === 0 ? "–" : n}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="dl-bar">
                  <i className="seg-ok" style={{ width: `${Math.round((dHealth.okN / tot) * 100)}%` }} />
                  <i className="seg-warn" style={{ width: `${Math.round((dHealth.warnN / tot) * 100)}%` }} />
                  <i className="seg-crit" style={{ width: `${Math.round((dHealth.critN / tot) * 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
