"use client";

import { type ChangeEvent, useMemo, useRef, useState } from "react";
import {
  Barcode,
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileUp,
  History,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import * as XLSX from "xlsx";

type Cell = string | number | boolean | null;
type CacheMeta = { status: "hit" | "miss" | "coalesced"; ageMs: number; ttlMs: number };

type BarcodeItem = {
  barcode: string;
  pid: Cell;
  availability: Cell;
  status: Cell;
  operation: Cell;
  location: Cell;
  locationType: Cell;
  condition: Cell;
  legalOwner: Cell;
  facility: Cell;
  updatedAt: Cell;
  updatedBy: Cell;
  createdAt: Cell;
  createdBy: Cell;
  actionId: Cell;
  enabled: Cell;
  barcodeScanRequired: Cell;
  boxBarcode: Cell;
  expiry: Cell;
};

type InventoryResult = {
  pid: string;
  items: BarcodeItem[];
  total: number;
  truncated: boolean;
  cache: CacheMeta | null;
  error: string | null;
};

type HistoryResult = {
  barcode: string;
  pid: string | null;
  cutoff: string | null;
  inventory: BarcodeItem | null;
  current: BarcodeItem | null;
  events: BarcodeItem[];
  total: number;
  cache: CacheMeta | null;
  error: string | null;
};

type ApiResponse = {
  ok: boolean;
  error?: string;
  mode?: "inventory" | "history";
  results?: InventoryResult[];
  history?: HistoryResult[];
  pidErrors?: Array<{ pid: string; error: string }>;
  fanout?: { requested: number; returned: number; truncated: boolean };
};

type Mode = "inventory" | "history";
type HistorySource = "barcode" | "pid";
type SortKey = "barcode" | "pid" | "availability" | "status" | "location" | "updatedAt";
type PidEntry = { pid: string; cutoff: string | null };
const MAX_IMPORT_BYTES = 15 * 1024 * 1024;

const INVENTORY_EXPORT_KEYS: Array<keyof BarcodeItem> = [
  "barcode", "pid", "availability", "status", "operation", "location", "locationType",
  "condition", "legalOwner", "facility", "updatedAt", "updatedBy", "createdAt", "createdBy",
  "actionId", "enabled", "barcodeScanRequired", "boxBarcode", "expiry",
];

function uniquePids(raw: string): string[] {
  return [...new Set(Array.from(raw.matchAll(/\b\d{4,12}\b/g), (match) => match[0]))];
}

function uniqueBarcodes(raw: string): string[] {
  const seen = new Set<string>();
  return raw.split(/[\s,;]+/).map((value) => value.trim().toUpperCase()).filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function parsePidEntries(raw: string): { entries: PidEntry[]; invalid: string[] } {
  const entries: PidEntry[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const commaParts = line.split(",").map((part) => part.trim()).filter(Boolean);
    if (commaParts.length > 1 && commaParts.every((part) => /^\d{4,12}$/.test(part))) {
      for (const pid of commaParts) {
        if (!seen.has(pid)) {
          seen.add(pid);
          entries.push({ pid, cutoff: null });
        }
      }
      continue;
    }
    const match = line.match(/^(\d{4,12})(?:[\s,\t]+(.+?))?$/);
    if (!match) {
      invalid.push(line);
      continue;
    }
    const pid = match[1];
    let cutoff: string | null = null;
    if (match[2]) {
      const parsed = new Date(match[2]);
      if (!Number.isFinite(parsed.getTime())) {
        invalid.push(line);
        continue;
      }
      cutoff = parsed.toISOString();
    }
    const key = `${pid}|${cutoff || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({ pid, cutoff });
    }
  }
  return { entries, invalid };
}

function display(value: Cell | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function tone(value: Cell | undefined): string {
  const status = String(value || "").toUpperCase();
  if (/AVAILABLE|GOOD|RELEASED|INVOICED|SUCCESS|DONE/.test(status) && !/NOT_/.test(status)) return "good";
  if (/NOT_FOUND|FAILED|ERROR|DAMAGED|BLOCKED|CANCEL/.test(status)) return "bad";
  if (/ALLOCATED|HOLD|PENDING/.test(status)) return "warn";
  return "info";
}

function formatDate(value: Cell | undefined): string {
  if (typeof value !== "string" || !value) return display(value);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
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

function inventoryExportRows(rows: BarcodeItem[]) {
  return rows.map((item) => Object.fromEntries(INVENTORY_EXPORT_KEYS.map((key) => [key, safeSpreadsheetCell(item[key])])));
}

function historyExportRows(results: HistoryResult[]) {
  return results.flatMap((result) => {
    const rows = result.events.length ? result.events : result.current ? [result.current] : [null];
    return rows.map((event) => ({
      PID: safeSpreadsheetCell(result.pid),
      Cutoff: safeSpreadsheetCell(result.cutoff),
      Barcode: safeSpreadsheetCell(result.barcode),
      UpdatedAt: safeSpreadsheetCell(event?.updatedAt),
      Operation: safeSpreadsheetCell(event?.operation),
      Location: safeSpreadsheetCell(event?.location),
      LocationType: safeSpreadsheetCell(event?.locationType),
      Availability: safeSpreadsheetCell(event?.availability || result.current?.availability),
      Status: safeSpreadsheetCell(event?.status || result.current?.status),
      UpdatedBy: safeSpreadsheetCell(event?.updatedBy),
      BoxBarcode: safeSpreadsheetCell(event?.boxBarcode),
      Condition: safeSpreadsheetCell(event?.condition || result.inventory?.condition),
      LegalOwner: safeSpreadsheetCell(event?.legalOwner || result.inventory?.legalOwner),
      Facility: safeSpreadsheetCell(event?.facility || result.inventory?.facility),
      Error: safeSpreadsheetCell(result.error),
    }));
  });
}

function downloadCsvRows(rows: Array<Record<string, string | number | boolean>>, filename: string) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [headers.map(csvCell).join(","), ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(","))].join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1_000);
}

export default function BarcodeIntelligencePage() {
  const [mode, setMode] = useState<Mode>("inventory");
  const [historySource, setHistorySource] = useState<HistorySource>("barcode");
  const [rawInput, setRawInput] = useState("");
  const [facility, setFacility] = useState("NXS1");
  const [condition, setCondition] = useState("GOOD");
  const [nonDispatchOnly, setNonDispatchOnly] = useState(true);
  const [inventoryResults, setInventoryResults] = useState<InventoryResult[]>([]);
  const [historyResults, setHistoryResults] = useState<HistoryResult[]>([]);
  const [pidErrors, setPidErrors] = useState<Array<{ pid: string; error: string }>>([]);
  const [fanoutWarning, setFanoutWarning] = useState("");
  const [query, setQuery] = useState("");
  const [availability, setAvailability] = useState("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("barcode");
  const [sortDirection, setSortDirection] = useState<1 | -1>(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const pids = useMemo(() => uniquePids(rawInput), [rawInput]);
  const barcodes = useMemo(() => uniqueBarcodes(rawInput), [rawInput]);
  const parsedPidEntries = useMemo(() => parsePidEntries(rawInput), [rawInput]);
  const inventoryRows = useMemo(() => inventoryResults.flatMap((result) => result.items), [inventoryResults]);
  const availabilityOptions = useMemo(() => [...new Set((mode === "inventory" ? inventoryRows : historyResults.map((item) => item.current).filter(Boolean) as BarcodeItem[])
    .map((item) => String(item.availability || "UNKNOWN")))].sort(), [historyResults, inventoryRows, mode]);
  const filteredInventory = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...inventoryRows].filter((item) => {
      if (availability !== "ALL" && String(item.availability || "UNKNOWN") !== availability) return false;
      return !needle || [item.barcode, item.pid, item.location, item.operation, item.status].some((value) => String(value || "").toLowerCase().includes(needle));
    }).sort((left, right) => String(left[sortKey] || "").localeCompare(String(right[sortKey] || ""), undefined, { numeric: true }) * sortDirection);
  }, [availability, inventoryRows, query, sortDirection, sortKey]);
  const filteredHistory = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return historyResults.filter((result) => {
      if (availability !== "ALL" && String(result.current?.availability || result.inventory?.availability || "UNKNOWN") !== availability) return false;
      return !needle || [result.barcode, result.pid, result.current?.location, result.current?.operation].some((value) => String(value || "").toLowerCase().includes(needle));
    });
  }, [availability, historyResults, query]);
  const metrics = useMemo(() => {
    if (mode === "inventory") {
      return {
        total: inventoryRows.length,
        available: inventoryRows.filter((item) => item.availability === "AVAILABLE").length,
        allocated: inventoryRows.filter((item) => item.availability === "ALLOCATED").length,
        exception: inventoryRows.filter((item) => String(item.availability || "").includes("NOT_FOUND")).length,
      };
    }
    return {
      total: historyResults.length,
      available: historyResults.reduce((sum, item) => sum + item.events.length, 0),
      allocated: historyResults.filter((item) => String(item.current?.availability || "").includes("NOT_FOUND")).length,
      exception: historyResults.filter((item) => item.error).length + pidErrors.length,
    };
  }, [historyResults, inventoryRows, mode, pidErrors.length]);

  function inputCount() {
    if (mode === "inventory") return pids.length;
    return historySource === "barcode" ? barcodes.length : parsedPidEntries.entries.length;
  }

  async function lookup(force = false) {
    if (!inputCount() || loading) return;
    if (mode === "history" && historySource === "pid" && parsedPidEntries.invalid.length) {
      setError(`Fix ${parsedPidEntries.invalid.length} invalid PID/cutoff line${parsedPidEntries.invalid.length === 1 ? "" : "s"}.`);
      return;
    }
    setLoading(true);
    setError("");
    setFanoutWarning("");
    try {
      const body = mode === "inventory"
        ? { mode, pids, facility, condition, fetchNonDispatchOnly: nonDispatchOnly, force }
        : historySource === "barcode"
          ? { mode, source: historySource, barcodes, facility, force }
          : { mode, source: historySource, pidEntries: parsedPidEntries.entries, facility, condition, force };
      const response = await fetch("/api/stock-in/barcode-intelligence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as ApiResponse;
      if (!response.ok || !payload.ok) throw new Error(payload.error || `Request failed with HTTP ${response.status}.`);
      if (mode === "inventory") {
        setInventoryResults(payload.results || []);
        setHistoryResults([]);
      } else {
        const nextHistory = payload.history || [];
        setHistoryResults(nextHistory);
        setInventoryResults([]);
        setExpanded(new Set(nextHistory.length <= 2 ? nextHistory.map((item) => `${item.pid || "direct"}:${item.barcode}`) : []));
        setPidErrors(payload.pidErrors || []);
        if (payload.fanout?.truncated) setFanoutWarning(`History fan-out was capped at ${payload.fanout.returned} of ${payload.fanout.requested} barcodes.`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Barcode lookup failed.");
    } finally {
      setLoading(false);
    }
  }

  function switchMode(nextMode: Mode) {
    if (loading) return;
    setMode(nextMode);
    setRawInput("");
    setInventoryResults([]);
    setHistoryResults([]);
    setPidErrors([]);
    setQuery("");
    setAvailability("ALL");
    setError("");
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("Files larger than 15 MB are not accepted.");
      let source: string;
      if (/\.xlsx?$/i.test(file.name)) {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
        source = workbook.SheetNames.map((name) => XLSX.utils.sheet_to_csv(workbook.Sheets[name])).join("\n");
      } else source = await file.text();
      setRawInput(source);
      setError("");
    } catch {
      setError("The selected file could not be read.");
    } finally {
      event.target.value = "";
    }
  }

  function setSort(next: SortKey) {
    if (sortKey === next) setSortDirection((current) => current === 1 ? -1 : 1);
    else {
      setSortKey(next);
      setSortDirection(1);
    }
  }

  function toggleHistory(result: HistoryResult) {
    const key = `${result.pid || "direct"}:${result.barcode}`;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function exportData(kind: "csv" | "xlsx") {
    const rows = mode === "inventory" ? inventoryExportRows(inventoryRows) : historyExportRows(historyResults);
    if (kind === "csv") {
      downloadCsvRows(rows, `barcode_${mode}_${timestamp()}.csv`);
      return;
    }
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), mode === "inventory" ? "Inventory" : "History");
    if (mode === "history") {
      const currentRows = historyResults.map((result) => ({
        PID: safeSpreadsheetCell(result.pid),
        Barcode: safeSpreadsheetCell(result.barcode),
        Availability: safeSpreadsheetCell(result.current?.availability || result.inventory?.availability),
        Location: safeSpreadsheetCell(result.current?.location || result.inventory?.location),
        Operation: safeSpreadsheetCell(result.current?.operation || result.inventory?.operation),
        UpdatedAt: safeSpreadsheetCell(result.current?.updatedAt || result.inventory?.updatedAt),
        Records: result.total,
        Error: safeSpreadsheetCell(result.error),
      }));
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(currentRows), "Current Status");
    }
    XLSX.writeFile(workbook, `barcode_${mode}_${timestamp()}.xlsx`, { compression: true });
  }

  function clearAll() {
    if (loading) return;
    setRawInput("");
    setInventoryResults([]);
    setHistoryResults([]);
    setPidErrors([]);
    setFanoutWarning("");
    setQuery("");
    setError("");
  }

  const hasResults = mode === "inventory" ? inventoryResults.length > 0 : historyResults.length > 0;
  const maxInputs = mode === "inventory" ? 50 : historySource === "barcode" ? 100 : 20;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Stock in · IMS intelligence</div>
          <h1>Barcode intelligence</h1>
          <p className="lede">Find physical barcode inventory by PID or inspect the complete movement timeline by barcode or PID cutoff.</p>
        </div>
        <div className="tabs" role="tablist" aria-label="Barcode workflow">
          <button className={`tab ${mode === "inventory" ? "active" : ""}`} onClick={() => switchMode("inventory")} role="tab" type="button"><Barcode size={12} /> Inventory</button>
          <button className={`tab ${mode === "history" ? "active" : ""}`} onClick={() => switchMode("history")} role="tab" type="button"><History size={12} /> History</button>
        </div>
      </div>

      <section className="split-layout">
        <div className="card card-pad sticky-panel stack">
          {mode === "history" && (
            <div className="field">
              <span className="label">History input type</span>
              <div className="tabs">
                <button className={`tab ${historySource === "barcode" ? "active" : ""}`} onClick={() => { setHistorySource("barcode"); clearAll(); }} type="button">Barcodes</button>
                <button className={`tab ${historySource === "pid" ? "active" : ""}`} onClick={() => { setHistorySource("pid"); clearAll(); }} type="button">PID + cutoff</button>
              </div>
            </div>
          )}

          <div className="field">
            <label className="label" htmlFor="barcode-input">
              {mode === "inventory" ? "Product IDs" : historySource === "barcode" ? "Barcodes" : "PID and optional cutoff"}
            </label>
            <textarea
              className="textarea mono"
              id="barcode-input"
              onChange={(event) => setRawInput(event.target.value)}
              onKeyDown={(event) => { if (event.ctrlKey && event.key === "Enter") void lookup(false); }}
              placeholder={mode === "inventory" ? "223354\n220624" : historySource === "barcode" ? "BC000000001\nBC000000002" : "223354 2026-04-12 11:22:44\n220624"}
              style={{ minHeight: 145 }}
              value={rawInput}
            />
            <span className="dim mono" style={{ fontSize: 10 }}>{inputCount()} valid · maximum {maxInputs}{parsedPidEntries.invalid.length > 0 && historySource === "pid" ? ` · ${parsedPidEntries.invalid.length} invalid` : ""}</span>
          </div>

          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="barcode-facility">Facility</label>
              <input className="input mono" id="barcode-facility" maxLength={16} onChange={(event) => setFacility(event.target.value.toUpperCase())} value={facility} />
            </div>
            {(mode === "inventory" || historySource === "pid") && (
              <div className="field">
                <label className="label" htmlFor="barcode-condition">Condition</label>
                <select className="select" id="barcode-condition" onChange={(event) => setCondition(event.target.value)} value={condition}>
                  <option value="">All conditions</option><option value="GOOD">Good</option><option value="BAD">Bad</option><option value="DAMAGED">Damaged</option>
                </select>
              </div>
            )}
          </div>

          {mode === "inventory" && (
            <label className="alert" style={{ alignItems: "center", cursor: "pointer" }}>
              <input checked={nonDispatchOnly} onChange={(event) => setNonDispatchOnly(event.target.checked)} type="checkbox" />
              Only inventory that has not been dispatched
            </label>
          )}

          <input ref={fileRef} hidden type="file" accept=".txt,.csv,.xls,.xlsx" onChange={readFile} />
          <div className="toolbar">
            <button className="button primary" disabled={!inputCount() || inputCount() > maxInputs || loading} onClick={() => lookup(false)} type="button">
              {loading ? <span className="spinner" /> : <Search size={14} />} {loading ? "Fetching…" : mode === "inventory" ? "Fetch inventory" : "Fetch history"}
            </button>
            <button className="button" disabled={loading} onClick={() => fileRef.current?.click()} type="button"><FileUp size={14} /> Import</button>
            <button className="button ghost" disabled={loading} onClick={clearAll} type="button"><Trash2 size={14} /> Clear</button>
          </div>
          {hasResults && <button className="button" disabled={loading} onClick={() => lookup(true)} type="button"><RefreshCw size={13} /> Refresh upstream</button>}
          {error && <div className="alert error">{error}</div>}
          {fanoutWarning && <div className="alert warning">{fanoutWarning}</div>}
          {pidErrors.map((item) => <div className="alert error" key={item.pid}>PID {item.pid}: {item.error}</div>)}
          <div className="alert">Barcode inventory and history are cached for 2 minutes per normalized entity. Tokens never enter the browser.</div>
        </div>

        <div className="stack">
          <div className="metric-grid">
            <div className="metric blue"><div className="metric-label">{mode === "inventory" ? "Barcodes" : "Lookups"}</div><div className="metric-value">{metrics.total.toLocaleString("en-IN")}</div><div className="metric-foot">{mode === "inventory" ? `${inventoryResults.length} PIDs` : "resolved barcode records"}</div></div>
            <div className="metric teal"><div className="metric-label">{mode === "inventory" ? "Available" : "Events"}</div><div className="metric-value">{metrics.available.toLocaleString("en-IN")}</div><div className="metric-foot">{mode === "inventory" ? "ready inventory" : "timeline movements"}</div></div>
            <div className="metric amber"><div className="metric-label">{mode === "inventory" ? "Allocated" : "Not found"}</div><div className="metric-value">{metrics.allocated.toLocaleString("en-IN")}</div><div className="metric-foot">{mode === "inventory" ? "committed inventory" : "current exceptions"}</div></div>
            <div className="metric rose"><div className="metric-label">{mode === "inventory" ? "Not found" : "Errors"}</div><div className="metric-value">{metrics.exception.toLocaleString("en-IN")}</div><div className="metric-foot">requires attention</div></div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">{mode === "inventory" ? "Barcode inventory" : "Movement history"} <span className="badge">{mode === "inventory" ? filteredInventory.length : filteredHistory.length}</span></div>
                <div className="card-subtitle">IMS · {facility}</div>
              </div>
              <div className="toolbar">
                <div style={{ position: "relative" }}>
                  <Search size={13} style={{ position: "absolute", left: 10, top: 9, color: "var(--text-3)" }} />
                  <input className="input" aria-label="Filter barcode results" onChange={(event) => setQuery(event.target.value)} placeholder="Filter" style={{ height: 31, paddingLeft: 30, width: 160 }} value={query} />
                </div>
                <select className="select" aria-label="Availability filter" onChange={(event) => setAvailability(event.target.value)} style={{ height: 31, width: 135 }} value={availability}>
                  <option value="ALL">All availability</option>
                  {availabilityOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
                <button className="button small" disabled={!hasResults} onClick={() => exportData("csv")} type="button"><Download size={12} /> CSV</button>
                <button className="button small" disabled={!hasResults} onClick={() => exportData("xlsx")} type="button"><FileSpreadsheet size={12} /> XLSX</button>
              </div>
            </div>

            {!hasResults ? (
              <div className="empty"><span><strong>No barcode data yet</strong>Choose a mode, add identifiers, and run a secure same-origin lookup.</span></div>
            ) : mode === "inventory" ? (
              <div className="table-wrap" style={{ maxHeight: 640 }}>
                <table>
                  <thead><tr>
                    {(["barcode", "pid", "availability", "status", "operation", "location", "updatedAt"] as SortKey[]).map((key) => (
                      <th key={key}><button className="button ghost small" onClick={() => setSort(key)} style={{ minHeight: 20, padding: 0, textTransform: "uppercase" }} type="button">{key}{sortKey === key ? sortDirection === 1 ? " ↑" : " ↓" : ""}</button></th>
                    ))}
                    <th>Updated by</th><th>Condition</th><th>Owner</th><th>Box barcode</th>
                  </tr></thead>
                  <tbody>
                    {filteredInventory.map((item, index) => (
                      <tr key={`${item.barcode}:${index}`}>
                        <td className="table-id">{display(item.barcode)}</td>
                        <td className="mono">{display(item.pid)}</td>
                        <td><span className={`badge ${tone(item.availability)}`}>{display(item.availability)}</span></td>
                        <td><span className={`badge ${tone(item.status)}`}>{display(item.status)}</span></td>
                        <td>{display(item.operation)}</td><td>{display(item.location)}</td><td>{formatDate(item.updatedAt)}</td>
                        <td>{display(item.updatedBy)}</td><td>{display(item.condition)}</td><td>{display(item.legalOwner)}</td><td className="mono">{display(item.boxBarcode)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="stack" style={{ padding: 14, maxHeight: 660, overflow: "auto" }}>
                {filteredHistory.map((result) => {
                  const key = `${result.pid || "direct"}:${result.barcode}`;
                  const open = expanded.has(key);
                  const current = result.current || result.inventory;
                  return (
                    <article className="card" key={key}>
                      <button
                        aria-expanded={open}
                        className="card-header"
                        onClick={() => toggleHistory(result)}
                        style={{ width: "100%", color: "inherit", background: "transparent", cursor: "pointer", textAlign: "left" }}
                        type="button"
                      >
                        <span className="toolbar">
                          <ChevronDown size={14} style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 150ms" }} />
                          <span className="table-id">{result.barcode}</span>
                          {result.pid && <span className="badge violet">PID {result.pid}</span>}
                          {result.cutoff && <span className="badge">after {formatDate(result.cutoff)}</span>}
                          <span className={`badge ${tone(current?.availability)}`}>{display(current?.availability)}</span>
                          {result.error && <span className="badge bad">ERROR</span>}
                        </span>
                        <span className="card-subtitle">{display(current?.location)} · {result.events.length} events · {result.cache?.status || "no cache"}</span>
                      </button>
                      {open && (
                        <div>
                          {result.error ? <div className="alert error" style={{ margin: 12 }}>{result.error}</div> : (
                            <div className="table-wrap" style={{ maxHeight: 360 }}>
                              <table>
                                <thead><tr><th>#</th><th>Updated at</th><th>Operation</th><th>Location</th><th>Location type</th><th>Availability</th><th>Status</th><th>Updated by</th><th>Box barcode</th></tr></thead>
                                <tbody>
                                  {!result.events.length ? <tr><td className="table-empty" colSpan={9}>No movement events match this lookup or cutoff.</td></tr> : result.events.map((event, index) => (
                                    <tr key={`${result.barcode}:${display(event.updatedAt)}:${index}`}>
                                      <td className="dim mono">{index + 1}</td><td>{formatDate(event.updatedAt)}</td><td>{display(event.operation)}</td><td className={event.location === "Bermuda Triangle" ? "rose" : ""}>{display(event.location)}</td>
                                      <td>{display(event.locationType)}</td><td><span className={`badge ${tone(event.availability)}`}>{display(event.availability)}</span></td><td>{display(event.status)}</td><td>{display(event.updatedBy)}</td><td className="mono">{display(event.boxBarcode)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
