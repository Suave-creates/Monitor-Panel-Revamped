"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import {
  bandBuckets,
  DEPT_META,
  DEPT_ORDER,
  deptOrdersMap,
  filterByLensType,
  type AgingItem,
  type BucketDef,
  type DeptKey,
  type StagesData,
} from "../lib/aggregate";
import type { LensTypeFilter, PidSets } from "../lib/pidClassify";
import {
  activeBuckets,
  bandFromHist,
  bucketColLabel,
  fmt,
  getLatestBucket,
  loadAllSnapshots,
  rowLabel,
  saveAllSnapshots,
  shiftCycleKey,
  shiftPhase,
  SHIFT_HOURS,
  snapshotStorageKey,
  timestamp,
  captureSnapshot,
  type Snapshot,
  type StageSnapshots,
} from "../lib/shiftReport";
import { downloadTextFile, type PipelineData, type QcfailData } from "../types";

const DEPT_CONFIG: Record<DeptKey, { columns: string[]; colLabel: Record<string, string>; holdCols: string[] }> = {
  WAREHOUSE: {
    columns: ["Synced", "JIT Processing", "Pending Picking", "In Picking"],
    colLabel: {},
    holdCols: [],
  },
  MEI: {
    columns: ["EDGING", "IN_TRAY"],
    colLabel: { EDGING: "EDGING", IN_TRAY: "IN TRAY" },
    holdCols: [],
  },
  FITTING: {
    columns: ["PENDING_CUSTOMIZATION"],
    colLabel: { PENDING_CUSTOMIZATION: "PENDING CUSTOMISATION" },
    holdCols: [],
  },
  QC: {
    columns: ["QC_HOLD", "IN_QC", "CUSTOMIZATION_COMPLETE"],
    colLabel: { QC_HOLD: "QC HOLD", IN_QC: "IN QC", CUSTOMIZATION_COMPLETE: "CUST COMPLETE" },
    holdCols: ["QC_HOLD"],
  },
  QCFAIL: {
    columns: ["ASRS", "LL", "IN_TRAY", "MEI", "FITTING", "ORDER_QC_REWORK"],
    colLabel: { ASRS: "ASRS", LL: "LENS LAB", IN_TRAY: "IN TRAY", MEI: "MEI", FITTING: "FITTING", ORDER_QC_REWORK: "BACK AT QC" },
    holdCols: [],
  },
  PACKING_DISPATCH: {
    columns: ["Packing", "Manifest"],
    colLabel: {},
    holdCols: [],
  },
};
const DCLS = ["d1", "d2", "d3"];
const EMPTY_STAGES = {} as StagesData;

type Props = {
  facility: string;
  jit: string;
  frFilter: string;
  stages: StagesData | null;
  qcfailOrders: QcfailData["orders"];
  warehouseOrders: PipelineData["orders"];
  packingOrders: PipelineData["orders"];
  fetchedAt: string | null;
  buckets: Record<DeptKey, BucketDef[]>;
  pidSets: PidSets;
  lensTypeFilter: LensTypeFilter;
  onDrilldown: (title: string, subtitle: string, orders: AgingItem[]) => void;
};

/** The NDD shift snapshot report — every refresh captures one row for the
 *  current clock hour into an 11-hour 6 PM -> 4 AM ladder for EACH of the
 *  six departments. Only the LATEST (live) row can drill down into real
 *  orders — sealed past hours only ever stored an aggregate count, not
 *  the order list itself (matching the source extension's design, and
 *  keeping browser storage light across a whole shift). This is where
 *  "hour bucketing" starts: see lib/shiftReport.ts. Always P1-only
 *  (locked, like the source extension's report.html). */
export default function ShiftReportView(props: Props) {
  const { facility, jit, frFilter, fetchedAt, buckets, onDrilldown } = props;
  const storageKey = useMemo(() => snapshotStorageKey(facility, jit, frFilter), [facility, jit, frFilter]);
  const [snapshots, setSnapshots] = useState<Record<DeptKey, StageSnapshots>>(() => {
    const empty = {} as Record<DeptKey, StageSnapshots>;
    DEPT_ORDER.forEach((k) => { empty[k] = {}; });
    return empty;
  });
  const lastCapturedAt = useRef<string | null>(null);

  const deptOrders = useMemo(() => {
    const all = deptOrdersMap(props.stages ?? EMPTY_STAGES, props.qcfailOrders, props.warehouseOrders, props.packingOrders, props.pidSets);
    const out = {} as Record<DeptKey, AgingItem[]>;
    (Object.keys(all) as DeptKey[]).forEach((dept) => { out[dept] = filterByLensType(all[dept], props.lensTypeFilter); });
    return out;
  }, [props.stages, props.qcfailOrders, props.warehouseOrders, props.packingOrders, props.pidSets, props.lensTypeFilter]);

  useEffect(() => {
    // This effect intentionally hydrates client-only shift snapshots for the current filter scope.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnapshots(loadAllSnapshots(storageKey));
    lastCapturedAt.current = null;
  }, [storageKey]);

  useEffect(() => {
    if (!fetchedAt || fetchedAt === lastCapturedAt.current) return;
    lastCapturedAt.current = fetchedAt;
    setSnapshots((prev) => {
      const next = { ...prev } as Record<DeptKey, StageSnapshots>;
      DEPT_ORDER.forEach((dept) => {
        const items = (deptOrders[dept] || []).map((o) => ({ column: o.status, dwell: o.dwell }));
        const snap = captureSnapshot(items, DEPT_CONFIG[dept].columns);
        next[dept] = { ...next[dept], [snap.bucket]: snap };
      });
      saveAllSnapshots(storageKey, next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedAt, storageKey]);

  function clearShift() {
    if (!confirm("Clear all snapshot rows for this shift?\n\nThis cannot be undone.")) return;
    const empty = {} as Record<DeptKey, StageSnapshots>;
    DEPT_ORDER.forEach((k) => { empty[k] = {}; });
    setSnapshots(empty);
    saveAllSnapshots(storageKey, empty);
  }

  function exportCsv() {
    let csv = `NDD Shift Report — ${facility} — ${new Date().toLocaleString("en-IN")}\n`;
    DEPT_ORDER.forEach((dept) => {
      const cfg = DEPT_CONFIG[dept];
      const snaps = Object.fromEntries(Object.entries(snapshots[dept]).filter(([b]) => SHIFT_HOURS.includes(Number(b))));
      const hours = Object.keys(snaps).map(Number).sort((a, b) => shiftCycleKey(a) - shiftCycleKey(b));
      if (!hours.length) return;
      csv += `\n${DEPT_META[dept].name}\nTIME`;
      cfg.columns.forEach((c) => { csv += `,${cfg.colLabel[c] || c},>1Hr,>2Hr,>3Hr`; });
      csv += ",TOTAL_ORDERS\n";
      hours.forEach((h) => {
        const snap = snaps[h];
        const line: (string | number)[] = [rowLabel(h, snap)];
        cfg.columns.forEach((col) => { const v = snap.cols[col] || [0, 0, 0, 0]; line.push(v[0], v[1], v[2], v[3]); });
        line.push(snap.rowTotal);
        csv += line.join(",") + "\n";
      });
    });
    downloadTextFile(csv, `ndd-shift-report-${timestamp()}.csv`);
  }

  const phase = shiftPhase();

  return (
    <div className="stack">
      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <span className={`badge ${phase === "active" ? "good" : ""}`}>
          {phase === "active" ? "● NDD Shift Active · 6:00 PM – 4:00 AM" : "Pre-Shift · NDD tracking starts at 6:00 PM"}
        </span>
        <div className="toolbar">
          <button type="button" className="button" onClick={exportCsv}><Download size={13} /> Export shift CSV</button>
          <button type="button" className="button danger" onClick={clearShift}><Trash2 size={13} /> Clear shift</button>
        </div>
      </div>

      <ShiftBand snapshots={snapshots} phase={phase} />

      {DEPT_ORDER.map((dept) => (
        <DeptShiftTable
          key={dept}
          dept={dept}
          snaps={snapshots[dept]}
          liveItems={deptOrders[dept] || []}
          buckets={activeBuckets(buckets[dept])}
          onDrilldown={onDrilldown}
        />
      ))}
    </div>
  );
}

function ShiftBand({ snapshots, phase }: { snapshots: Record<DeptKey, StageSnapshots>; phase: "active" | "pre" }) {
  const currentHour = new Date().getHours();
  const pulseH = (currentHour + 23) % 24;

  return (
    <div className="card card-pad">
      <div className="sb-segs">
        {SHIFT_HOURS.map((h) => {
          const isCurrent = h === pulseH && phase === "active";
          const isPast = shiftCycleKey(h) < shiftCycleKey(pulseH) && phase === "active";
          let rag = "empty";
          if (isPast || isCurrent) {
            let g3 = 0, g2 = 0, g1 = 0;
            DEPT_ORDER.forEach((dept) => {
              const snap = snapshots[dept][h];
              if (!snap) return;
              DEPT_CONFIG[dept].columns.forEach((c) => {
                const v = snap.cols[c] || [0, 0, 0, 0];
                g3 += v[3]; g2 += v[2]; g1 += v[1];
              });
            });
            rag = g3 > 0 ? "g3" : g2 > 0 ? "g2" : g1 > 0 ? "g1" : "ok";
          }
          return (
            <div key={h} className={`sb-seg sb-${rag}${isCurrent ? " sb-current" : ""}`} title={`${h}:00`}>
              <span className="sb-lbl">{["12", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"][h % 12]}{h < 12 ? "A" : "P"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DeptShiftTable({
  dept, snaps, liveItems, buckets, onDrilldown,
}: {
  dept: DeptKey; snaps: StageSnapshots; liveItems: AgingItem[]; buckets: Exclude<BucketDef, null>[];
  onDrilldown: (title: string, subtitle: string, orders: AgingItem[]) => void;
}) {
  const cfg = DEPT_CONFIG[dept];
  const meta = DEPT_META[dept];
  const cols = cfg.columns;
  const phase = shiftPhase();
  const bKeys = Object.keys(snaps);

  let sortedHours = bKeys.map(Number).sort((a, b) => shiftCycleKey(a) - shiftCycleKey(b));
  if (phase !== "active") {
    const lb = getLatestBucket(snaps);
    sortedHours = lb != null ? [lb] : [];
  }

  const latestB = getLatestBucket(snaps);
  const nb = buckets.length;
  const holdBand = holdAlert(meta.name, cfg.holdCols, snaps, latestB);

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">{meta.ico} {meta.name}</div>
          <div className="card-subtitle">Hour-by-hour shift snapshot — latest hour drills down, sealed hours show counts only</div>
        </div>
      </div>
      {holdBand && <div className="alert warning" style={{ margin: "12px 17px 0" }}>{holdBand}</div>}
      {!sortedHours.length ? (
        <div className="empty">
          <span>
            <strong>{phase === "active" ? "No snapshot captured yet" : "NDD shift starts at 6:00 PM"}</strong>
            {phase === "active" ? "Hit Refresh to capture the first snapshot." : "Current stage counts are on the Report tab above."}
          </span>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="dm">
            <thead>
              <tr>
                <th rowSpan={2}>TIME</th>
                {cols.map((col) => {
                  const latSnap = latestB != null ? snaps[latestB] : null;
                  const cnt = latSnap ? (latSnap.cols[col]?.[0] || 0) : 0;
                  return (
                    <th key={col} colSpan={Math.max(1, nb)}>{cfg.colLabel[col] || col} <span className="dim">({fmt(cnt)})</span></th>
                  );
                })}
                <th rowSpan={2}>TOTAL<br />ORDERS</th>
              </tr>
              <tr>
                {cols.map((col) => (
                  nb ? buckets.map((d, i) => <th key={`${col}-${i}`}>{bucketColLabel(d)}</th>) : <th key={col}>—</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedHours.map((h, idx) => {
                const snap = snap_(snaps, h);
                const isLatest = h === latestB;
                const trend = isLatest && sortedHours.length > 1 ? trendFor(cols, snap, snap_(snaps, sortedHours[idx - 1])) : null;
                const rowLbl = rowLabel(h, snap);
                let rowOrders: AgingItem[] = [];
                return (
                  <tr key={h} className={isLatest ? "snap-latest" : ""}>
                    <td className="td-time">{isLatest ? "⏱ " : ""}{rowLbl}{trend}</td>
                    {cols.map((col) => {
                      if (!isLatest) {
                        const bands = buckets.map((d) => bandFromHist(snap.hist[col], d, buckets));
                        return (
                          <Fragment key={col}>
                            {nb ? bands.map((bv, i) => (
                              <td key={`${col}-${i}`} className={bv > 0 ? DCLS[Math.min(i, 2)] : "d0z"}>{bv || "—"}</td>
                            )) : <td className="d0z">—</td>}
                          </Fragment>
                        );
                      }
                      const colItems = liveItems.filter((o) => o.status === col);
                      rowOrders = rowOrders.concat(colItems);
                      const bands = bandBuckets(colItems, buckets);
                      return (
                        <Fragment key={col}>
                          {nb ? bands.map((band, i) => {
                            const n = band ? band.list.length : 0;
                            return (
                              <td key={`${col}-${i}`} className={n > 0 ? DCLS[Math.min(i, 2)] : "d0z"}>
                                {n > 0 && band ? (
                                  <button type="button" className="dl-cell-btn" onClick={() => onDrilldown(`${meta.name} — ${cfg.colLabel[col] || col} ${bucketColLabel(band.def)}`, "NDD Shift Report", band.list)}>{n}</button>
                                ) : "—"}
                              </td>
                            );
                          }) : <td className="d0z">—</td>}
                        </Fragment>
                      );
                    })}
                    <td className={rowOrders.length === 0 && !isLatest ? "zero" : ""}>
                      {isLatest ? (
                        rowOrders.length > 0 ? (
                          <button type="button" className="dl-cell-btn" onClick={() => onDrilldown(`${meta.name} — ${rowLbl}`, "NDD Shift Report", rowOrders)}>{fmt(rowOrders.length)}</button>
                        ) : "0"
                      ) : (fmt(snap.rowTotal) || "0")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function snap_(snaps: StageSnapshots, h: number): Snapshot {
  return snaps[h] || { ts: "", bucket: h, cols: {}, hist: {}, rowTotal: 0 };
}

function trendFor(cols: string[], latest: Snapshot, prev: Snapshot | null) {
  if (!prev || !prev.ts) return null;
  let lD1 = 0, pD1 = 0;
  cols.forEach((c) => {
    const lv = latest.cols[c] || [0, 0, 0, 0];
    const pv = prev.cols[c] || [0, 0, 0, 0];
    lD1 += lv[1] + lv[2] + lv[3];
    pD1 += pv[1] + pv[2] + pv[3];
  });
  if (lD1 > pD1) return <span className="rose" style={{ marginLeft: 6 }}>↑{lD1 - pD1}</span>;
  if (lD1 < pD1) return <span className="teal" style={{ marginLeft: 6 }}>↓{pD1 - lD1}</span>;
  return <span className="dim" style={{ marginLeft: 6 }}>→</span>;
}

function holdAlert(label: string, holdCols: string[], snaps: StageSnapshots, latestB: number | null) {
  if (latestB == null) return null;
  const snap = snaps[latestB];
  if (!snap) return null;
  const cols = holdCols.length ? holdCols : Object.keys(snap.cols);
  let band2 = 0, band3 = 0;
  cols.forEach((c) => {
    const v = snap.cols[c];
    if (!v) return;
    band2 += v[2];
    band3 += v[3];
  });
  if (!band2 && !band3) return null;
  const parts: string[] = [];
  if (band2) parts.push(`${band2} order${band2 > 1 ? "s" : ""} in >2–3 Hr`);
  if (band3) parts.push(`${band3} CRITICAL (>3 Hr) — immediate action needed`);
  return `⚠ ${label}${holdCols.length ? " HOLD" : ""}: ${parts.join(" · ")}`;
}
