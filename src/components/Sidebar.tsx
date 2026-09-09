"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Boxes,
  ChevronsLeft,
  ChevronsRight,
  Gauge,
  House,
  PackageCheck,
  ReceiptText,
  ScanBarcode,
} from "lucide-react";

const COLLAPSE_STORAGE_KEY = "nexs-sidebar-collapsed";

const groups = [
  {
    label: "Monitor",
    items: [
      { href: "/monitoring/kpi-dashboard", label: "KPI Dashboard", icon: Gauge },
      { href: "/packing-dispatch/do-order-visibility", label: "DO Visibility", icon: PackageCheck },
    ],
  },
  {
    label: "Lookups",
    items: [
      { href: "/stock-in/inventory-fetcher", label: "Inventory", icon: Boxes },
      { href: "/stock-in/barcode-intelligence", label: "Barcodes", icon: ScanBarcode },
      { href: "/stock-in/invoice-bulk", label: "Invoices", icon: ReceiptText },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // This effect intentionally synchronizes collapsed state with the stored preference.
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1") setCollapsed(true);
    } catch {
      // localStorage unavailable — keep the sidebar expanded.
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try { localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0"); } catch {
        // localStorage unavailable — the toggle still works for this session.
      }
      return next;
    });
  };

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`} aria-label="Primary navigation">
      <Link className="brand" href="/" aria-label="NexS Console home">
        <span className="brand-mark"><Activity size={19} strokeWidth={2.4} /></span>
        <span>
          <strong>NexS</strong>
          <small>OPS CONSOLE</small>
        </span>
      </Link>

      <button
        type="button"
        className="icon-button sidebar-toggle"
        onClick={toggleCollapsed}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
      </button>

      <nav className="sidebar-nav">
        <Link className={`nav-link ${pathname === "/" ? "active" : ""}`} href="/" title="Overview">
          <House size={17} />
          <span className="nav-text">Overview</span>
        </Link>
        {groups.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-label">{group.label}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link className={`nav-link ${active ? "active" : ""}`} href={item.href} key={item.href} title={item.label}>
                  <Icon size={17} />
                  <span className="nav-text">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <span className="live-dot" />
        <span className="nav-text">Server-authenticated</span>
      </div>
    </aside>
  );
}
