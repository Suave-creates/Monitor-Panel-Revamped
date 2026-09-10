"use client";

import { ArrowLeft, FileSpreadsheet } from "lucide-react";
import OrdersTable, { type OrdersColumn } from "./OrdersTable";
import { DEPT_META, STAGE_META, toExportRow, type PendencyItem } from "../lib/clAggregate";
import { downloadXlsxRows, dwellClass, fmtHours, timestamp } from "../types";

const COLUMNS: OrdersColumn<PendencyItem>[] = [
  { key: "dept", label: "Category", get: (o) => DEPT_META[o.dept].name },
  { key: "stage", label: "Stage", get: (o) => STAGE_META[o.stage].label },
  { key: "incrementId", label: "Increment", get: (o) => o.incrementId, className: () => "table-id" },
  { key: "shippingPackageId", label: "Package", get: (o) => o.shippingPackageId, className: () => "mono" },
  { key: "itemType", label: "Item Type", get: (o) => o.items[0]?.itemType || "" },
  { key: "barcode", label: "Barcode", get: (o) => o.items[0]?.barcode || "", className: () => "mono" },
  { key: "productId", label: "Product ID", get: (o) => o.items[0]?.productId || "", className: () => "mono" },
  { key: "items", label: "Items", get: (o) => o.items.length, className: () => "mono" },
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

/** CL Report's own "broad view" every clickable number opens into —
 *  mirrors Dispatch Report's DispatchDrilldownView but typed against
 *  clAggregate's PendencyItem. In Bulk's "shipment" (item-level) view
 *  mode, several rows here can share the same Increment/Package ID
 *  (one row per item on that shipment) — each item's own Order Item ID
 *  keeps the row key unique. Reuses the shared, fully-generic
 *  OrdersTable. */
export default function ClDrilldownView({ title, subtitle, orders, onBack }: Props) {
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
      <OrdersTable
        title="Orders"
        subtitle={subtitle}
        orders={orders}
        columns={COLUMNS}
        rowKey={(o) => `${o.shippingPackageId || o.incrementId}-${o.stage}-${o.items[0]?.orderItemId || o.items.length}`}
      />
    </div>
  );
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "orders";
}
