"use client";

import { type ChangeEvent, useMemo, useRef, useState } from "react";
import {
  Boxes,
  Download,
  FileSpreadsheet,
  FileUp,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import * as XLSX from "xlsx";

type Cell = string | number | boolean | null;
type CacheMeta = { status: "hit" | "miss" | "coalesced"; ageMs: number; ttlMs: number };

type InventoryData = {
  totalInventory: Cell;
  grn: Cell;
  allocated: Cell;
  available: Cell;
  reserved: Cell;
  blocked: Cell;
  pendingPutAway: Cell;
};

type ProductData = {
  productName: Cell;
  brand: Cell;
  hsnCode: Cell;
  hsnClassification: Cell;
  frameType: Cell;
  frameMaterial: Cell;
  sku: Cell;
  classification: Cell;
  fastPickingEnabled: Cell;
};

type InventoryResult = {
  pid: string;
  inventory: InventoryData | null;
  product: ProductData | null;
  cache: { inventory: CacheMeta | null; product: CacheMeta | null };
  error: string | null;
  catalogError: string | null;
};

type ApiResponse = { ok: boolean; error?: string; results?: InventoryResult[] };
const MAX_IMPORT_BYTES = 15 * 1024 * 1024;

function extractPids(raw: string): string[] {
  return [...new Set(Array.from(raw.matchAll(/\b\d{4,12}\b/g), (match) => match[0]))];
}

function display(value: Cell | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function numberValue(value: Cell | undefined): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function safeSpreadsheetCell(value: unknown): string | number | boolean {
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = value === null || value === undefined ? "" : String(value);
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown): string {
  return `"${String(safeSpreadsheetCell(value)).replace(/"/g, '""')}"`;
}

function timestamp() {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
}

function exportRows(results: InventoryResult[]) {
  return results.map((result) => ({
    "Product ID": safeSpreadsheetCell(result.pid),
    "Total Inventory": safeSpreadsheetCell(result.inventory?.totalInventory),
    GRN: safeSpreadsheetCell(result.inventory?.grn),
    Allocated: safeSpreadsheetCell(result.inventory?.allocated),
    Available: safeSpreadsheetCell(result.inventory?.available),
    Reserved: safeSpreadsheetCell(result.inventory?.reserved),
    Blocked: safeSpreadsheetCell(result.inventory?.blocked),
    "Pending PutAway": safeSpreadsheetCell(result.inventory?.pendingPutAway),
    "Product Name": safeSpreadsheetCell(result.product?.productName),
    Brand: safeSpreadsheetCell(result.product?.brand),
    "HSN Code": safeSpreadsheetCell(result.product?.hsnCode),
    "HSN Classification": safeSpreadsheetCell(result.product?.hsnClassification),
    "Frame Type": safeSpreadsheetCell(result.product?.frameType),
    "Frame Material": safeSpreadsheetCell(result.product?.frameMaterial),
    SKU: safeSpreadsheetCell(result.product?.sku),
    Classification: safeSpreadsheetCell(result.product?.classification),
    "Fast Picking Enabled": safeSpreadsheetCell(result.product?.fastPickingEnabled),
    Error: safeSpreadsheetCell(result.error),
    "Catalog Warning": safeSpreadsheetCell(result.catalogError),
  }));
}

export default function InventoryFetcherPage() {
  const [rawInput, setRawInput] = useState("");
  const [facility, setFacility] = useState("NXS1");
  const [workstation, setWorkstation] = useState("722706112");
  const [results, setResults] = useState<InventoryResult[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const pids = useMemo(() => extractPids(rawInput), [rawInput]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return results;
    return results.filter((result) => [
      result.pid,
      result.product?.productName,
      result.product?.brand,
      result.product?.sku,
      result.product?.hsnClassification,
    ].some((value) => String(value || "").toLowerCase().includes(needle)));
  }, [query, results]);
  const totals = useMemo(() => ({
    total: results.reduce((sum, item) => sum + numberValue(item.inventory?.totalInventory), 0),
    available: results.reduce((sum, item) => sum + numberValue(item.inventory?.available), 0),
    allocated: results.reduce((sum, item) => sum + numberValue(item.inventory?.allocated), 0),
    blocked: results.reduce((sum, item) => sum + numberValue(item.inventory?.blocked), 0),
  }), [results]);

  async function lookup(force = false) {
    if (!pids.length || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/stock-in/inventory-fetcher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pids, facility, workstation, force }),
      });
      const payload = await response.json() as ApiResponse;
      if (!response.ok || !payload.ok || !payload.results) {
        throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
      }
      setResults(payload.results);
    } catch (reason) {
      setResults([]);
      setError(reason instanceof Error ? reason.message : "Inventory lookup failed.");
    } finally {
      setLoading(false);
    }
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("Files larger than 15 MB are not accepted.");
      let source = "";
      if (/\.xlsx?$/i.test(file.name)) {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
        source = workbook.SheetNames.map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name])).join("\n");
      } else {
        source = await file.text();
      }
      const imported = extractPids(source);
      if (!imported.length) throw new Error("No product IDs were found in the selected file.");
      setRawInput(imported.join("\n"));
      setResults([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The selected file could not be read.");
    } finally {
      event.target.value = "";
    }
  }

  function createCsv(): string {
    const rows = exportRows(results);
    if (!rows.length) return "";
    const headers = Object.keys(rows[0]);
    return [headers.map(csvCell).join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header as keyof typeof row])).join(","))].join("\r\n");
  }

  function downloadCsv() {
    const url = URL.createObjectURL(new Blob(["\uFEFF", createCsv()], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `inventory_lookup_${timestamp()}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    window.setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 1_000);
  }

  function downloadWorkbook() {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(exportRows(results)), "Inventory");
    XLSX.writeFile(workbook, `inventory_lookup_${timestamp()}.xlsx`, { compression: true });
  }

  function clearAll() {
    if (loading) return;
    setRawInput("");
    setResults([]);
    setQuery("");
    setError("");
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Stock in · product inventory</div>
          <h1>Inventory fetcher</h1>
          <p className="lede">Combine consolidated warehouse quantities with six-hour product catalog metadata for up to 100 PIDs.</p>
        </div>
        <span className="badge good"><Boxes size={12} /> Live NexS inventory</span>
      </div>

      <section className="split-layout">
        <div className="card card-pad sticky-panel stack">
          <div className="field">
            <label className="label" htmlFor="inventory-pids">Product IDs</label>
            <textarea
              className="textarea mono"
              id="inventory-pids"
              onChange={(event) => setRawInput(event.target.value)}
              onKeyDown={(event) => { if (event.ctrlKey && event.key === "Enter") void lookup(false); }}
              placeholder={"220624\n223354\n241005"}
              value={rawInput}
            />
            <span className="dim mono" style={{ fontSize: 10 }}>{pids.length} unique · 4–12 digits · maximum 100</span>
          </div>

          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="inventory-facility">Facility</label>
              <input className="input mono" id="inventory-facility" maxLength={16} onChange={(event) => setFacility(event.target.value.toUpperCase())} value={facility} />
            </div>
            <div className="field">
              <label className="label" htmlFor="inventory-workstation">Workstation</label>
              <input className="input mono" id="inventory-workstation" maxLength={32} onChange={(event) => setWorkstation(event.target.value)} value={workstation} />
            </div>
          </div>

          <input ref={fileRef} hidden type="file" accept=".txt,.csv,.xls,.xlsx" onChange={readFile} />
          <div className="toolbar">
            <button className="button primary" disabled={!pids.length || pids.length > 100 || loading} onClick={() => lookup(false)} type="button">
              {loading ? <span className="spinner" /> : <Search size={14} />} {loading ? `Fetching ${pids.length}…` : "Fetch inventory"}
            </button>
            <button className="button" disabled={loading} onClick={() => fileRef.current?.click()} type="button"><FileUp size={14} /> Import</button>
            <button className="button ghost" disabled={loading} onClick={clearAll} type="button"><Trash2 size={14} /> Clear</button>
          </div>
          {results.length > 0 && <button className="button" disabled={loading} onClick={() => lookup(true)} type="button"><RefreshCw size={13} /> Refresh inventory</button>}
          {error && <div className="alert error">{error}</div>}
          <div className="alert">Inventory is cached for 2 minutes per facility/PID. Catalog metadata is cached for 6 hours per PID.</div>
        </div>

        <div className="stack">
          <div className="metric-grid">
            <div className="metric violet"><div className="metric-label">Total inventory</div><div className="metric-value">{totals.total.toLocaleString("en-IN")}</div><div className="metric-foot">all loaded products</div></div>
            <div className="metric teal"><div className="metric-label">Available</div><div className="metric-value">{totals.available.toLocaleString("en-IN")}</div><div className="metric-foot">ready stock</div></div>
            <div className="metric amber"><div className="metric-label">Allocated</div><div className="metric-value">{totals.allocated.toLocaleString("en-IN")}</div><div className="metric-foot">committed stock</div></div>
            <div className="metric rose"><div className="metric-label">Blocked</div><div className="metric-value">{totals.blocked.toLocaleString("en-IN")}</div><div className="metric-foot">unavailable stock</div></div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Product inventory <span className="badge">{filtered.length} / {results.length}</span></div>
                <div className="card-subtitle">Consolidated inventory + catalog</div>
              </div>
              <div className="toolbar">
                <div style={{ position: "relative" }}>
                  <Search size={13} style={{ position: "absolute", left: 10, top: 9, color: "var(--text-3)" }} />
                  <input className="input" aria-label="Filter inventory results" onChange={(event) => setQuery(event.target.value)} placeholder="Filter products" style={{ height: 31, paddingLeft: 30, width: 190 }} value={query} />
                </div>
                <button className="button small" disabled={!results.length} onClick={downloadCsv} type="button"><Download size={12} /> CSV</button>
                <button className="button small" disabled={!results.length} onClick={downloadWorkbook} type="button"><FileSpreadsheet size={12} /> XLSX</button>
              </div>
            </div>
            {!results.length ? (
              <div className="empty"><span><strong>No product data yet</strong>Paste PIDs or import a workbook, then fetch consolidated inventory.</span></div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 620 }}>
                <table>
                  <thead><tr>
                    <th>PID</th><th className="right">Total</th><th className="right">GRN</th><th className="right">Allocated</th><th className="right">Available</th><th className="right">Reserved</th><th className="right">Blocked</th><th className="right">PutAway</th>
                    <th>Product</th><th>Brand</th><th>HSN</th><th>Classification</th><th>Frame type</th><th>Material</th><th>SKU</th><th>Fast pick</th><th>Cache</th>
                  </tr></thead>
                  <tbody>
                    {filtered.map((result) => (
                      <tr key={result.pid}>
                        <td className="table-id">{result.pid}</td>
                        {result.error ? (
                          <td colSpan={15} className="rose wrap">{result.error}</td>
                        ) : (
                          <>
                            <td className="right mono">{display(result.inventory?.totalInventory)}</td>
                            <td className="right mono">{display(result.inventory?.grn)}</td>
                            <td className="right mono amber">{display(result.inventory?.allocated)}</td>
                            <td className="right mono teal">{display(result.inventory?.available)}</td>
                            <td className="right mono">{display(result.inventory?.reserved)}</td>
                            <td className="right mono rose">{display(result.inventory?.blocked)}</td>
                            <td className="right mono">{display(result.inventory?.pendingPutAway)}</td>
                            <td className="wrap" title={display(result.product?.productName)}>{display(result.product?.productName)}</td>
                            <td>{display(result.product?.brand)}</td>
                            <td className="mono">{display(result.product?.hsnCode)}</td>
                            <td title={display(result.product?.hsnClassification)}>{display(result.product?.hsnClassification)}</td>
                            <td>{display(result.product?.frameType)}</td>
                            <td>{display(result.product?.frameMaterial)}</td>
                            <td className="mono">{display(result.product?.sku)}</td>
                            <td><span className={`badge ${result.product?.fastPickingEnabled === true ? "good" : ""}`}>{display(result.product?.fastPickingEnabled)}</span></td>
                          </>
                        )}
                        <td title={result.catalogError || ""}><span className={`badge ${result.catalogError ? "warn" : ""}`}>{result.cache.inventory?.status || "—"}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
