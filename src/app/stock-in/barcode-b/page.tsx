"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Download, ScanBarcode } from "lucide-react";

type Row = { barcode: string; pid: string | null; latestLocation: string | null; latestFacility: string | null; locations: string[]; updatedAt: string | null; updatedBy: string | null; error: string | null; found: boolean; skipped: boolean };
const columns = ["Barcode", "PID", "Latest Location", "Latest Facility", "Last 4 unique locations — 1", "2", "3", "4", "Latest Updated_at", "Latest Updated_by"];
const MAX_BARCODES = 200_000;
const CHUNK_SIZE = 10_000;
const REQUEST_SIZE = 100;
const PARALLEL_REQUESTS = 3;
const PAGE_SIZE = 100;
function cells(row: Row) { return [row.barcode, row.pid, row.latestLocation, row.latestFacility, ...Array.from({ length: 4 }, (_, i) => row.locations[i] || null), row.updatedAt, row.updatedBy]; }
function normalizeBarcode(value: string) {
  return value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").toUpperCase();
}
function isValidBarcode(barcode: string) {
  return /^[A-Z0-9][A-Z0-9._:/-]{11}$/.test(barcode);
}
function invalidBarcodeMessage(barcode: string) {
  const invalid = [...barcode].find((character) => !/[A-Z0-9._:/-]/.test(character));
  const detail = invalid ? ` Unsupported character U+${invalid.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}.` : " Use exactly 12 characters, starting with a letter or number.";
  return `Invalid barcode ${JSON.stringify(barcode.slice(0, 100))}.${detail}`;
}

export default function BarcodeBPage() {
  const [input, setInput] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cleanupMessage, setCleanupMessage] = useState("");
  const [completed, setCompleted] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [page, setPage] = useState(0);
  const barcodes = useMemo(() => [...new Set(input.split(/[\s,;]+/).map(normalizeBarcode).filter(Boolean))], [input]);
  const invalidCount = useMemo(() => barcodes.filter((barcode) => !isValidBarcode(barcode)).length, [barcodes]);
  const retryBarcodes = useMemo(() => rows.filter((row) => row.error || row.skipped).map((row) => row.barcode), [rows]);
  const summary = useMemo(() => ({ found: rows.filter((row) => row.found).length, missing: rows.filter((row) => !row.found && !row.error).length, failed: rows.filter((row) => row.error && !row.skipped).length, skipped: rows.filter((row) => row.skipped).length }), [rows]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visibleRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const progressPercent = progress.total ? Math.floor(progress.processed / progress.total * 100) : 0;

  function removeInvalidInputs() {
    setInput(barcodes.filter(isValidBarcode).join("\n"));
    setError("");
    setCleanupMessage(`Removed ${invalidCount.toLocaleString("en-IN")} invalid ${invalidCount === 1 ? "input" : "inputs"}.`);
  }

  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!barcodes.length || barcodes.length > MAX_BARCODES) { setError("Enter between 1 and 200,000 unique barcodes."); return; }
    const invalidBarcode = barcodes.find((barcode) => !isValidBarcode(barcode));
    if (invalidBarcode !== undefined) {
      setError(invalidBarcodeMessage(invalidBarcode)); return;
    }
    await runLookup(barcodes);
  }

  async function runLookup(targets: string[], retry = false) {
    if (loading || !targets.length) return;
    setLoading(true); setError(""); setCompleted(false);
    if (!retry) { setRows([]); setPage(0); }
    setProgress({ processed: 0, total: targets.length });
    let processed = 0;
    try {
      for (let offset = 0; offset < targets.length; offset += CHUNK_SIZE) {
        const chunk = targets.slice(offset, offset + CHUNK_SIZE);
        for (let start = 0; start < chunk.length; start += REQUEST_SIZE * PARALLEL_REQUESTS) {
          const batches = Array.from({ length: PARALLEL_REQUESTS }, (_, index) => chunk.slice(start + index * REQUEST_SIZE, start + (index + 1) * REQUEST_SIZE)).filter((batch) => batch.length);
          const responses = await Promise.allSettled(batches.map(async (batch): Promise<Row[]> => {
            const response = await fetch("/api/stock-in/barcode-b", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ barcodes: batch }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Barcode lookup failed.");
            if (!Array.isArray(data.results) || data.results.length !== batch.length) throw new Error("Unexpected lookup response.");
            return data.results;
          }));
          const results = responses.flatMap((response) => response.status === "fulfilled" ? response.value : []);
          if (results.length) {
            processed += results.length;
            setRows((previous) => {
              if (!retry) return [...previous, ...results];
              const replacements = new Map(results.map((row) => [row.barcode, row]));
              return previous.map((row) => replacements.get(row.barcode) || row);
            });
            setProgress({ processed, total: targets.length });
          }
          const failure = responses.find((response) => response.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
      }
      setCompleted(true);
    } catch (err) { setError(err instanceof Error ? err.message : "Barcode lookup failed."); }
    finally { setLoading(false); }
  }

  function exportCsv() {
    const quote = (value: string | null) => {
      const safe = value && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value || "";
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const content = [columns.concat("Result"), ...rows.map((row) => [...cells(row), row.error || (row.found ? "Found" : "No history found")])].map((row) => row.map(quote).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\ufeff", content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "barcode-b.csv"; link.click(); URL.revokeObjectURL(url);
  }

  return <div className="barcode-b">
    <header><div className="kicker"><ScanBarcode size={16} /> STOCK IN</div><h1>Barcode B</h1><p>Latest location and the four most recent unique history locations for each barcode. Responses taking longer than 10 seconds are skipped.</p></header>
    <form onSubmit={lookup} className="panel">
      <label htmlFor="barcodes">Barcodes (12 characters each)</label>
      <textarea id="barcodes" value={input} onChange={(event) => { setInput(event.target.value); setCleanupMessage(""); setError(""); }} disabled={loading} placeholder="CCC157337735" rows={5} aria-describedby="barcode-help" />
      {invalidCount > 0 && <div className="actions"><span>{invalidCount.toLocaleString("en-IN")} invalid {invalidCount === 1 ? "input" : "inputs"} detected.</span><button type="button" className="secondary" disabled={loading} onClick={removeInvalidInputs}>Remove invalid inputs</button></div>}
      {cleanupMessage && <p role="status">{cleanupMessage}</p>}
      <div className="actions"><span id="barcode-help">Paste up to 200,000 barcodes, separated by lines, spaces or commas. {barcodes.length.toLocaleString("en-IN")} unique. Checked in chunks of 10,000.</span><button disabled={loading || !barcodes.length} type="submit">{loading ? "Looking up…" : "Get history"}</button></div>
    </form>
    {error && <div role="alert" className="error">{error}</div>}
    {progress.total > 0 && <div className="panel progress-panel">
      <div className="progress-label"><label htmlFor="barcode-progress">{loading ? "Lookup progress" : completed ? "Lookup complete" : "Lookup stopped"}</label><span>{progressPercent}% · {progress.processed.toLocaleString("en-IN")} / {progress.total.toLocaleString("en-IN")} checked</span></div>
      <progress id="barcode-progress" max={progress.total} value={progress.processed} />
      <p>Progress updates throughout each chunk, including skipped and failed barcodes.</p>
    </div>}
    <section className="panel" aria-busy={loading}>
      <div className="results-head"><div><h2>Barcode summary</h2><p>Locations 1–4 are distinct, newest first; location 1 may match Latest Location. Timestamps are shown as returned by NexS.</p></div><button type="button" className="secondary" disabled={!rows.length || loading} onClick={exportCsv}><Download size={14} /> Export CSV</button></div>
      <p role="status">{loading ? `${progress.processed.toLocaleString("en-IN")} / ${progress.total.toLocaleString("en-IN")} checked · Fetching chunk ${Math.min(Math.floor(progress.processed / CHUNK_SIZE) + 1, Math.ceil(progress.total / CHUNK_SIZE))} of ${Math.ceil(progress.total / CHUNK_SIZE)}…` : completed || rows.length ? `${summary.found.toLocaleString("en-IN")} found · ${summary.missing.toLocaleString("en-IN")} without history · ${summary.skipped.toLocaleString("en-IN")} skipped · ${summary.failed.toLocaleString("en-IN")} failed${completed ? "" : " · Lookup stopped; completed results are retained."}` : "Enter barcodes to begin."}</p>
      <div className="table-scroll"><table><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}<th>Result</th></tr></thead><tbody>
        {!rows.length && <tr><td colSpan={columns.length + 1} className="empty">{loading ? "Loading results…" : "No barcode results yet."}</td></tr>}
        {visibleRows.map((row) => <tr key={row.barcode}>{cells(row).map((value, index) => <td key={index}>{value || "—"}</td>)}<td className={row.error ? "error-text" : ""}>{row.error || (row.found ? "Found" : "No history found")}</td></tr>)}
      </tbody></table></div>
      {rows.length > 0 && <div className="actions"><span>Page {page + 1} of {pageCount} · {rows.length.toLocaleString("en-IN")} results · CSV includes all results.</span><div className="actions"><button type="button" className="secondary" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button><button type="button" className="secondary" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>Next</button></div></div>}
      {!loading && retryBarcodes.length > 0 && <div className="actions"><span>Retry failed and skipped barcodes. Successful results are kept.</span><button type="button" onClick={() => void runLookup(retryBarcodes, true)}>Retry failed / skipped ({retryBarcodes.length.toLocaleString("en-IN")})</button></div>}
    </section>
    <style jsx>{`
      .barcode-b { color:var(--text); background:var(--bg-soft); padding:24px; border-radius:12px; }
      header { margin-bottom:24px; } .kicker { display:flex; align-items:center; gap:8px; color:var(--blue); font-size:12px; font-weight:700; margin-bottom:10px; }
      h1 { color:var(--text); } p { color:var(--text-2); line-height:1.6; font-size:13px; } header p { margin-bottom:0; }
      .panel { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:20px; margin-bottom:20px; }
      .progress-label { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
      .progress-label label { margin-bottom:0; } .progress-label span { color:var(--text-2); font-size:12px; }
      progress { display:block; width:100%; height:12px; border:0; border-radius:6px; overflow:hidden; background:var(--surface-3); appearance:none; }
      progress::-webkit-progress-bar { background:var(--surface-3); border-radius:6px; }
      progress::-webkit-progress-value { background:var(--blue); border-radius:6px; transition:width 200ms ease; }
      progress::-moz-progress-bar { background:var(--blue); border-radius:6px; }
      .progress-panel p { margin:10px 0 0; font-size:12px; }
      label { display:block; font-weight:600; margin-bottom:10px; } textarea { width:100%; resize:vertical; border:1px solid var(--line-strong); border-radius:6px; padding:12px; background:var(--surface-2); color:var(--text); font-family:var(--mono); }
      textarea::placeholder { color:var(--placeholder); }
      textarea:focus-visible, button:focus-visible { outline:3px solid var(--blue); outline-offset:2px; }
      .actions, .results-head { display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap; } .actions { margin-top:14px; } .actions span { color:var(--text-2); font-size:12px; }
      button { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--blue); background:var(--blue-dim); color:var(--blue); padding:10px 16px; border-radius:6px; cursor:pointer; font-weight:600; }
      button:disabled { opacity:.5; cursor:not-allowed; } .secondary { background:var(--surface); color:var(--blue); } h2 { color:var(--text); } .results-head p { margin-bottom:0; max-width:760px; }
      .table-scroll { overflow:auto; max-height:650px; } table { width:100%; border-collapse:collapse; font-size:12px; } th, td { padding:12px; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap; }
      th { background:var(--bg-sticky); color:var(--text-2); position:sticky; top:0; font-size:11px; } tbody tr:hover { background:var(--row-hover-bg); } .empty { text-align:center; padding:40px; color:var(--text-2); }
      .error { background:var(--rose-dim); color:var(--alert-rose-text); padding:14px; margin-bottom:20px; border:1px solid var(--rose); border-radius:6px; } .error-text { color:var(--rose); }
      @media(max-width:640px) { .barcode-b { padding:14px; } .panel { padding:14px; } }
    `}</style>
  </div>;
}
