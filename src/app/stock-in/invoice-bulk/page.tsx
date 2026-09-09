"use client";

import { type ChangeEvent, useMemo, useRef, useState } from "react";
import {
  Clipboard,
  Download,
  FileSpreadsheet,
  FileUp,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import * as XLSX from "xlsx";

type Cell = string | number | boolean | null;

type InvoiceRow = {
  vendorInvoiceNumber: Cell;
  invoiceReferenceNumber: Cell;
  purchaseOrderNumber: Cell;
  status: Cell;
  totalInvoiceQuantity: Cell;
  acceptedQuantity: Cell;
  pendingQuantity: Cell;
  rejectedQuantity: Cell;
  invoiceDate: Cell;
  createdAt: Cell;
  closedAt: Cell;
  createdBy: Cell;
  vendorId: Cell;
  facilityCode: Cell;
  legalOwner: Cell;
  prefilledInvoice: Cell;
  totalSamplingQuantity: Cell;
  qcDone: Cell;
  qcPass: Cell;
};

type CacheMeta = { status: "hit" | "miss" | "coalesced"; ageMs: number; ttlMs: number };

type InvoiceResult = {
  invoiceNumber: string;
  hits: number;
  row: InvoiceRow | null;
  cache: CacheMeta | null;
  error: string | null;
};

type ApiResponse = {
  ok: boolean;
  error?: string;
  facility?: string;
  results?: InvoiceResult[];
};
const MAX_IMPORT_BYTES = 15 * 1024 * 1024;

const EXPORT_COLUMNS: Array<{ key: keyof InvoiceRow; label: string }> = [
  { key: "vendorInvoiceNumber", label: "Vendor Invoice Number" },
  { key: "invoiceReferenceNumber", label: "Invoice Reference" },
  { key: "purchaseOrderNumber", label: "Purchase Order" },
  { key: "status", label: "Status" },
  { key: "totalInvoiceQuantity", label: "Total Invoice Qty" },
  { key: "acceptedQuantity", label: "Accepted Qty" },
  { key: "pendingQuantity", label: "Pending Qty" },
  { key: "rejectedQuantity", label: "Rejected Qty" },
  { key: "invoiceDate", label: "Invoice Date" },
  { key: "createdAt", label: "Created At" },
  { key: "closedAt", label: "Closed At" },
  { key: "createdBy", label: "Created By" },
  { key: "vendorId", label: "Vendor ID" },
  { key: "facilityCode", label: "Facility" },
  { key: "legalOwner", label: "Legal Owner" },
  { key: "prefilledInvoice", label: "Prefilled Invoice" },
  { key: "totalSamplingQuantity", label: "Sampling Qty" },
  { key: "qcDone", label: "QC Done" },
  { key: "qcPass", label: "QC Pass" },
];

function parseInvoiceText(raw: string): string[] {
  const seen = new Set<string>();
  return raw
    .split(/[\n,;]+/)
    .map((value) => value.trim().replace(/\s+/g, " ").toUpperCase())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function display(value: Cell | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function statusTone(result: InvoiceResult): string {
  if (result.error) return "bad";
  if (!result.row || result.hits === 0) return "warn";
  const status = String(result.row.status || "").toUpperCase();
  if (/APPROVED|CLOSED|COMPLETED|PASS/.test(status)) return "good";
  if (/REJECTED|FAILED|CANCELLED/.test(status)) return "bad";
  if (/CREATED|PENDING|PROCESS/.test(status)) return "info";
  return "violet";
}

function statusLabel(result: InvoiceResult): string {
  if (result.error) return "ERROR";
  if (!result.row || result.hits === 0) return "NOT FOUND";
  return display(result.row.status).toUpperCase();
}

function safeSpreadsheetCell(value: unknown): string | number | boolean {
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = value === null || value === undefined ? "" : String(value);
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown): string {
  const safe = String(safeSpreadsheetCell(value));
  return `"${safe.replace(/"/g, '""')}"`;
}

function exportRows(results: InvoiceResult[]) {
  return results.map((result) => {
    const output: Record<string, string | number | boolean> = {
      "Input Invoice Number": safeSpreadsheetCell(result.invoiceNumber),
      "Lookup Result": safeSpreadsheetCell(statusLabel(result)),
      Hits: result.hits,
    };
    for (const column of EXPORT_COLUMNS) {
      output[column.label] = safeSpreadsheetCell(result.row?.[column.key]);
    }
    output.Error = safeSpreadsheetCell(result.error);
    return output;
  });
}

function timestamp() {
  return new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
}

export default function InvoiceBulkPage() {
  const [rawInput, setRawInput] = useState("");
  const [facility, setFacility] = useState("NXS1");
  const [results, setResults] = useState<InvoiceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const invoices = useMemo(() => parseInvoiceText(rawInput), [rawInput]);
  const metrics = useMemo(() => ({
    found: results.filter((item) => item.row && item.hits > 0 && !item.error).length,
    missing: results.filter((item) => !item.row && !item.error).length,
    errors: results.filter((item) => item.error).length,
    cacheHits: results.filter((item) => item.cache?.status === "hit").length,
  }), [results]);

  async function lookup(force = false) {
    if (!invoices.length || loading) return;
    setLoading(true);
    setError("");
    setCopied(false);
    try {
      const response = await fetch("/api/stock-in/invoice-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceNumbers: invoices, facility, force }),
      });
      const payload = await response.json() as ApiResponse;
      if (!response.ok || !payload.ok || !payload.results) {
        throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
      }
      setResults(payload.results);
    } catch (reason) {
      setResults([]);
      setError(reason instanceof Error ? reason.message : "Invoice lookup failed.");
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
      if (/\.xlsx?$/i.test(file.name)) {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const values = workbook.SheetNames.flatMap((name) => {
          const sheet = workbook.Sheets[name];
          const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
          return rows.map((row) => row[0]).filter((value) => value !== undefined && value !== null);
        });
        setRawInput(values.map(String).join("\n"));
      } else {
        setRawInput(await file.text());
      }
      setResults([]);
    } catch {
      setError("The selected file could not be read.");
    } finally {
      event.target.value = "";
    }
  }

  function createCsv(): string {
    const rows = exportRows(results);
    if (!rows.length) return "";
    const headers = Object.keys(rows[0]);
    return [
      headers.map(csvCell).join(","),
      ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
    ].join("\r\n");
  }

  function downloadCsv() {
    const url = URL.createObjectURL(new Blob(["\uFEFF", createCsv()], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `invoice_lookup_${timestamp()}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    window.setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 1_000);
  }

  function downloadWorkbook() {
    const sheet = XLSX.utils.json_to_sheet(exportRows(results));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Invoice Lookup");
    XLSX.writeFile(workbook, `invoice_lookup_${timestamp()}.xlsx`, { compression: true });
  }

  async function copyCsv() {
    try {
      await navigator.clipboard.writeText(createCsv());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Clipboard access was denied by the browser.");
    }
  }

  function clearAll() {
    if (loading) return;
    setRawInput("");
    setResults([]);
    setError("");
    setCopied(false);
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Stock in · purchase invoices</div>
          <h1>Invoice bulk lookup</h1>
          <p className="lede">Search up to 100 vendor invoice numbers in one server-authenticated request, then copy or export the operational result.</p>
        </div>
        <span className="badge violet"><FileSpreadsheet size={12} /> 2 minute entity cache</span>
      </div>

      <section className="split-layout">
        <div className="card card-pad sticky-panel stack">
          <div className="field">
            <label className="label" htmlFor="invoice-input">Invoice numbers</label>
            <textarea
              className="textarea mono"
              id="invoice-input"
              onChange={(event) => setRawInput(event.target.value)}
              placeholder={"INV-10001\nINV-10002\nINV-10003"}
              value={rawInput}
            />
            <span className="dim mono" style={{ fontSize: 10 }}>{invoices.length} unique · maximum 100</span>
          </div>

          <div className="field">
            <label className="label" htmlFor="invoice-facility">Facility</label>
            <input
              className="input mono"
              id="invoice-facility"
              maxLength={16}
              onChange={(event) => setFacility(event.target.value.toUpperCase())}
              value={facility}
            />
          </div>

          <input ref={fileRef} hidden type="file" accept=".txt,.csv,.xls,.xlsx" onChange={readFile} />
          <div className="toolbar">
            <button className="button primary" disabled={!invoices.length || loading || invoices.length > 100} onClick={() => lookup(false)} type="button">
              {loading ? <span className="spinner" /> : <Search size={14} />}
              {loading ? `Fetching ${invoices.length}…` : "Fetch invoices"}
            </button>
            <button className="button" disabled={loading} onClick={() => fileRef.current?.click()} type="button"><FileUp size={14} /> Import</button>
            <button className="button ghost" disabled={loading && !results.length} onClick={clearAll} type="button"><Trash2 size={14} /> Clear</button>
          </div>

          {results.length > 0 && (
            <button className="button" disabled={loading} onClick={() => lookup(true)} type="button">
              <RefreshCw size={13} /> Refresh upstream
            </button>
          )}
          {error && <div className="alert error">{error}</div>}
        </div>

        <div className="stack">
          <div className="metric-grid">
            <div className="metric teal"><div className="metric-label">Found</div><div className="metric-value">{metrics.found}</div><div className="metric-foot">matching invoice records</div></div>
            <div className="metric amber"><div className="metric-label">Not found</div><div className="metric-value">{metrics.missing}</div><div className="metric-foot">no search result</div></div>
            <div className="metric rose"><div className="metric-label">Errors</div><div className="metric-value">{metrics.errors}</div><div className="metric-foot">request failures</div></div>
            <div className="metric violet"><div className="metric-label">Cache hits</div><div className="metric-value">{metrics.cacheHits}</div><div className="metric-foot">served without an upstream call</div></div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Invoice results <span className="badge">{results.length}</span></div>
                <div className="card-subtitle">Vendor, PO, quantity and QC details</div>
              </div>
              <div className="toolbar">
                <button className="button small" disabled={!results.length} onClick={copyCsv} type="button"><Clipboard size={12} /> {copied ? "Copied" : "Copy CSV"}</button>
                <button className="button small" disabled={!results.length} onClick={downloadCsv} type="button"><Download size={12} /> CSV</button>
                <button className="button small" disabled={!results.length} onClick={downloadWorkbook} type="button"><FileSpreadsheet size={12} /> XLSX</button>
              </div>
            </div>
            {!results.length ? (
              <div className="empty">
                <span><strong>No invoice results yet</strong>Add invoice numbers or import the first column of a workbook, then run the lookup.</span>
              </div>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 610 }}>
                <table>
                  <thead><tr>
                    <th>#</th><th>Input invoice</th><th>Result</th><th>PO number</th><th>Invoice ref</th>
                    <th className="right">Total</th><th className="right">Accepted</th><th className="right">Pending</th><th className="right">Rejected</th>
                    <th>Invoice date</th><th>Vendor</th><th>Created</th><th>Closed</th><th>Created by</th><th>Cache</th>
                  </tr></thead>
                  <tbody>
                    {results.map((result, index) => (
                      <tr key={result.invoiceNumber}>
                        <td className="dim mono">{index + 1}</td>
                        <td className="table-id">{result.invoiceNumber}</td>
                        <td><span className={`badge ${statusTone(result)}`}>{statusLabel(result)}</span></td>
                        <td>{display(result.row?.purchaseOrderNumber)}</td>
                        <td>{display(result.row?.invoiceReferenceNumber)}</td>
                        <td className="right mono">{display(result.row?.totalInvoiceQuantity)}</td>
                        <td className="right mono teal">{display(result.row?.acceptedQuantity)}</td>
                        <td className="right mono amber">{display(result.row?.pendingQuantity)}</td>
                        <td className="right mono rose">{display(result.row?.rejectedQuantity)}</td>
                        <td>{display(result.row?.invoiceDate)}</td>
                        <td>{display(result.row?.vendorId)}</td>
                        <td>{display(result.row?.createdAt)}</td>
                        <td>{display(result.row?.closedAt)}</td>
                        <td>{result.error ? <span className="rose">{result.error}</span> : display(result.row?.createdBy)}</td>
                        <td><span className="badge">{result.cache?.status || "—"}</span></td>
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
