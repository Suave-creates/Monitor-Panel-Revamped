"use client";

import type { MatrixRow } from "../lib/aggregate";

type Props = {
  columns: { key: string; tier: string }[];
  rows: MatrixRow[];
  legend: { tier: string; label: string }[];
  onCellClick: (row: MatrixRow, colIndex: number) => void;
  onTotalClick: (row: MatrixRow) => void;
};

export default function AgingMatrix({ columns, rows, legend, onCellClick, onTotalClick }: Props) {
  return (
    <div className="dl-matrix-wrap">
      <table className="dl-matrix">
        <thead>
          <tr>
            <th className="dl-row-h" />
            {columns.map((c) => <th key={c.key}>{c.key}</th>)}
            <th className="dl-total-h">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.dept}>
              <td className="dl-row-h"><span className="dl-row-ico">{r.meta.ico}</span>{r.meta.name}</td>
              {r.cells.map((cell, i) => (
                <td key={i} className={`dl-cell dl-${columns[i].tier}${cell.length === 0 ? " zero" : ""}`}>
                  {cell.length > 0 ? (
                    <button type="button" className="dl-cell-btn" onClick={() => onCellClick(r, i)}>{cell.length}</button>
                  ) : "0"}
                </td>
              ))}
              <td className="dl-total">
                {r.total > 0 ? (
                  <button type="button" className="dl-cell-btn dl-total-btn" onClick={() => onTotalClick(r)}>{r.total.toLocaleString("en-IN")}</button>
                ) : "0"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dl-legend">
        {legend.map((l) => <span key={l.tier} className={`dl-leg ${l.tier}`}><span className="dot" />{l.label}</span>)}
      </div>
    </div>
  );
}
