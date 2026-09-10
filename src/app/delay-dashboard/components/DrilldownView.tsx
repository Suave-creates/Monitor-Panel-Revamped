"use client";

import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import OrdersTable, { type OrdersColumn } from "./OrdersTable";
import { DEPT_META, toExportRow, type AgingItem } from "../lib/aggregate";
import { LENS_CLASS_LABEL } from "../lib/pidClassify";
import { downloadXlsxRows, dwellClass, fmtHours, timestamp } from "../types";

const COLUMNS: OrdersColumn<AgingItem>[] = [
  { key: "dept", label: "Department", get: (o) => DEPT_META[o.dept].name },
  { key: "incrementId", label: "Increment", get: (o) => o.incrementId, className: () => "table-id" },
  { key: "shippingPackageId", label: "Package", get: (o) => o.shippingPackageId, className: () => "mono" },
  { key: "unicom", label: "Unicom", get: (o) => o.unicom },
  { key: "statusLabel", label: "Status", get: (o) => o.statusLabel },
  { key: "lensClass", label: "Lens Type", get: (o) => LENS_CLASS_LABEL[o.lensClass] },
  { key: "dwell", label: "Dwell (Hrs)", get: (o) => fmtHours(o.dwell), className: (o) => `mono ${dwellClass(o.dwell)}` },
  { key: "aging", label: "Age (Hrs)", get: (o) => fmtHours(o.aging), className: () => "mono" },
  { key: "channel", label: "Channel", get: (o) => o.channel },
  { key: "trayNo", label: "Tray", get: (o) => o.trayNo },
  { key: "jitFlag", label: "JIT", get: (o) => (o.jitFlag ? "Y" : "") },
];

type Props = {
  title: string;
  subtitle: string;
  orders: AgingItem[];
  onBack: () => void;
};

/** The generic "broad view" every clickable number opens into — an order
 *  list matching exactly what was clicked, downloadable, with a Back
 *  button to return to Report or NDD Shift Report. Replaces what used to
 *  be six separate nav tabs (Order QC, Fitting, MEI, QC Fail, Warehouse,
 *  Packing & Dispatch): the same order-level detail, reached by clicking
 *  the count instead of a tab. */
export default function DrilldownView({ title, subtitle, orders, onBack }: Props) {
  function downloadXlsx() {
    downloadXlsxRows(orders.map(toExportRow), `${slug(title)}-${timestamp()}.xlsx`, "Orders");
  }

  return (
    <div className="stack">
      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <button type="button" className="button ghost" onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <div className="toolbar">
          <button type="button" className="button" disabled={!orders.length} onClick={downloadXlsx}><FileSpreadsheet size={13} /> Download XLSX</button>
        </div>
      </div>
      <div>
        <h2 style={{ marginBottom: 2 }}>{title}</h2>
        <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>{subtitle} · {orders.length.toLocaleString("en-IN")} order{orders.length === 1 ? "" : "s"}</p>
      </div>
      <OrdersTable title="Orders" subtitle={subtitle} orders={orders} columns={COLUMNS} rowKey={(o) => o.shippingPackageId || o.incrementId} />
    </div>
  );
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "orders";
}
