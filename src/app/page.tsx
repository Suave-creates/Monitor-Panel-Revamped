import Link from "next/link";
import {
  ArrowUpRight,
  Boxes,
  Gauge,
  PackageCheck,
  ReceiptText,
  ScanBarcode,
} from "lucide-react";

const tools = [
  { href: "/monitoring/kpi-dashboard", title: "KPI Dashboard", copy: "D1/D2/NDD completion, open stages and downloadable department detail.", icon: Gauge, tone: "teal", tag: "LIVE" },
  { href: "/packing-dispatch/do-order-visibility", title: "DO Visibility", copy: "Active distributor orders, aging, picking progress and PID impact.", icon: PackageCheck, tone: "blue", tag: "LIVE" },
  { href: "/stock-in/inventory-fetcher", title: "Inventory", copy: "Consolidated inventory and product attributes for a bulk PID list.", icon: Boxes, tone: "teal", tag: "LOOKUP" },
  { href: "/stock-in/barcode-intelligence", title: "Barcodes", copy: "Find physical barcode stock and inspect every movement in one place.", icon: ScanBarcode, tone: "blue", tag: "LOOKUP" },
  { href: "/stock-in/invoice-bulk", title: "Invoices", copy: "Search purchase invoices in bulk and export a clean operational file.", icon: ReceiptText, tone: "violet", tag: "LOOKUP" },
];

export default function HomePage() {
  return (
    <div className="page">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">Unified operations</div>
          <h1>Every signal.<br /><span className="teal">One control surface.</span></h1>
          <p className="lede">The Chrome tools are now a secure web workspace—shared navigation, server-side NexS access, responsive dashboards and consistent exports.</p>
        </div>
      </section>

      <div className="page-head section-gap" style={{ marginTop: 28 }}>
        <div>
          <div className="eyebrow">Tool directory</div>
          <h2>Operations modules</h2>
        </div>
        <span className="badge good"><span className="live-dot" /> 5 tools available</span>
      </div>

      <section className="tool-grid" aria-label="Operations tools">
        {tools.map(({ href, title, copy, icon: Icon, tone, tag }) => (
          <Link className="tool-card" href={href} key={href}>
            <span className={`tool-icon ${tone}`}><Icon size={16} /></span>
            <h3>{title}</h3>
            <p>{copy}</p>
            <span className="tool-meta"><span>{tag}</span><ArrowUpRight size={13} /></span>
          </Link>
        ))}
      </section>
    </div>
  );
}
