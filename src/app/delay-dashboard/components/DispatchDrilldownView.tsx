"use client";

import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import OrdersTable, { type OrdersColumn } from "./OrdersTable";
import { DEPT_META, STAGE_META, toExportRow, type PendencyItem } from "../lib/dispatchAggregate";
import { downloadXlsxRows, dwellClass, fmtHours, timestamp } from "../types";

const COLUMNS: OrdersColumn<PendencyItem>[] = [
  { key: "dept", label: "Category", get: (o) => DEPT_META[o.dept].name },
  { key: "stage", label: "Stage", get: (o) => STAGE_META[o.stage].label },
  { key: "incrementId", label: "Increment", get: (o) => o.incrementId, className: () => "table-id" },
  { key: "shippingPackageId", label: "Package", get: (o) => o.shippingPackageId, className: () => "mono" },
  { key: "unicom", label: "Unicom", get: (o) => o.unicom },
  { key: "status", label: "Status", get: (o) => o.status },
  { key: "dwell", label: "Dwell (Hrs)", get: (o) => fmtHours(o.dwell), className: (o) => `mono ${dwellClass(o.dwell)}` },
  { key: "aging", label: "Age (Hrs)", get: (o) => fmtHours(o.aging), className: () => "mono" },
  { key: "channel", label: "Channel", get: (o) => o.channel },
  { key: "trayNo", label: "Tray", get: (o) => o.trayNo },
  { key: "manifestNo", label: "Manifest", get: (o) => o.manifestNo },
  { key: "awbNo", label: "AWB", get: (o) => o.awbNo },
  { key: "jitFlag", label: "JIT", get: (o) => (o.jitFlag ? "Y" : "") },
];

type Props = {
  title: string;
  subtitle: string;
  orders: PendencyItem[];
  onBack: () => void;
};

/** The Dispatch Report tab's own "broad view" every clickable number
 *  opens into — mirrors this module's own DrilldownView but typed
 *  against PendencyItem (dispatch's order shape) instead of AgingItem.
 *  Reuses the shared, fully-generic OrdersTable. */
export default function DispatchDrilldownView({ title, subtitle, orders, onBack }: Props) {
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
      <OrdersTable title="Orders" subtitle={subtitle} orders={orders} columns={COLUMNS} rowKey={(o) => `${o.shippingPackageId || o.incrementId}-${o.stage}`} />
    </div>
  );
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "orders";
}
