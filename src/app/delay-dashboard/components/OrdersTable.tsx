"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";

export type OrdersColumn<T> = {
  key: string;
  label: string;
  get: (order: T) => string | number;
  className?: (order: T) => string | undefined;
};

type Props<T> = {
  title: string;
  subtitle: string;
  orders: T[];
  columns: OrdersColumn<T>[];
  rowKey: (order: T) => string;
  defaultSortKey?: string;
  loading?: boolean;
};

/** Shared sortable/searchable order table — used by the Stage, QC Fail,
 *  Warehouse, and Packing & Dispatch views of the ONE Delay Dashboard
 *  page. Local to this single module (not shared across features). */
export default function OrdersTable<T>({ title, subtitle, orders, columns, rowKey, defaultSortKey = "dwell", loading }: Props<T>) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState(defaultSortKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = orders;
    if (q) {
      rows = rows.filter((o) => columns.some((c) => String(c.get(o) ?? "").toLowerCase().includes(q)));
    }
    const col = columns.find((c) => c.key === sortKey);
    if (col) {
      rows = [...rows].sort((a, b) => {
        const av = col.get(a);
        const bv = col.get(b);
        const an = typeof av === "number" ? av : Number(av);
        const bn = typeof bv === "number" ? bv : Number(bv);
        const cmp = Number.isFinite(an) && Number.isFinite(bn) && String(av).trim() !== "" && String(bv).trim() !== ""
          ? an - bn
          : String(av ?? "").localeCompare(String(bv ?? ""));
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    return rows;
  }, [orders, columns, search, sortKey, sortDir]);

  function onSort(key: string) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">{title} <span className="badge">{filtered.length} / {orders.length}</span></div>
          <div className="card-subtitle">{subtitle}</div>
        </div>
        <div className="toolbar">
          <div style={{ position: "relative" }}>
            <Search size={13} style={{ position: "absolute", left: 10, top: 9, color: "var(--text-3)" }} />
            <input className="input" style={{ height: 31, paddingLeft: 30, width: 260 }} placeholder="Filter by order, package, unicom, tray, status…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
      </div>
      {!filtered.length ? (
        <div className="empty"><span><strong>No orders</strong>{loading ? "Loading…" : "Nothing matches the current filters."}</span></div>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 560 }}>
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} onClick={() => onSort(c.key)} style={{ cursor: "pointer" }}>
                    {c.label}{sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={rowKey(o)}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.className?.(o)}>{c.get(o)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
