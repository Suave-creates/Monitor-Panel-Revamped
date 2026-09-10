"use client";

import { useRef, useState } from "react";
import { RefreshCw, RotateCcw, UploadCloud } from "lucide-react";

type MasterStats = { updatedAt: string; source: string; cylCount: number; noncylCount: number };

type Props = {
  stats: MasterStats | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
};

/** PID Vault management — ported from the NJIT Prog Tracker extension's
 *  pidconfig.html/js. Lets ops replace either master list (CSV/TXT/TSV,
 *  first column read as Product IDs, a header row skipped automatically)
 *  or reset both back to the bundled defaults, without a code deploy.
 *  Persisted server-side; see src/lib/server/pid-masters.ts. */
export default function PidMastersView({ stats, loading, error, onReload }: Props) {
  return (
    <div className="stack">
      <div className="card card-pad">
        <p className="lede" style={{ marginBottom: 0 }}>
          The PID Vault classifies every order as <strong>Single Vision</strong> or <strong>Stock Progressive</strong> (further split into
          Cylindrical / Non-Cylindrical / Mixed) from its lens Product IDs — this is what the &quot;Lens Type&quot; filter uses everywhere
          on Report and NDD Shift Report. An order with lens PIDs in only the Cylindrical list is Cylindrical; only Non-Cylindrical is
          Non-Cylindrical; hits in both is Mixed; no hit in either list is Single Vision.
        </p>
      </div>

      <div className="toolbar">
        <button type="button" className="button" disabled={loading} onClick={onReload}>
          {loading ? <span className="spinner" /> : <RefreshCw size={13} />} {loading ? "Loading…" : "Reload"}
        </button>
        {stats && <span className="dim mono" style={{ fontSize: 10 }}>Last updated {stats.updatedAt} · {stats.source}</span>}
      </div>
      {error && <div className="alert error">⚠ {error}</div>}

      <div className="grid grid-2">
        <PidListCard side="cyl" label="Cylindrical" count={stats?.cylCount ?? null} onReload={onReload} />
        <PidListCard side="noncyl" label="Non-Cylindrical" count={stats?.noncylCount ?? null} onReload={onReload} />
      </div>

      <div className="card card-pad">
        <ResetButton onReload={onReload} />
      </div>
    </div>
  );
}

function parsePidsFromText(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const firstCell = (line: string) => line.split(/[,\t]/)[0]?.trim() ?? "";
  const isHeader = !/^\d+$/.test(firstCell(lines[0]));
  const dataLines = isHeader ? lines.slice(1) : lines;
  return [...new Set(dataLines.map(firstCell).filter((p) => /^\d+$/.test(p)))];
}

function PidListCard({ side, label, count, onReload }: { side: "cyl" | "noncyl"; label: string; count: number | null; onReload: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ name: string; pids: string[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const pids = parsePidsFromText(text);
      if (!pids.length) { setError("No numeric Product IDs found in that file."); return; }
      setPending({ name: file.name, pids });
    } catch {
      setError("Could not read that file.");
    }
  }

  async function apply() {
    if (!pending) return;
    setUploading(true);
    setError(null);
    try {
      const res = await fetch("/api/delay-dashboard/pid-masters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upload", side, pids: pending.pids, source: pending.name }),
      });
      const payload = await res.json();
      if (!res.ok || payload.ok !== true) throw new Error(payload.error || `Request failed (${res.status})`);
      setPending(null);
      onReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="card card-pad stack">
      <div className="card-title">{label}</div>
      <div className="metric-value" style={{ fontSize: 22 }}>{count == null ? "—" : count.toLocaleString("en-IN")}</div>
      <div className="metric-foot">Product IDs currently in this list</div>
      <input ref={fileRef} hidden type="file" accept=".csv,.txt,.tsv" onChange={onFile} />
      <div className="toolbar">
        <button type="button" className="button" onClick={() => fileRef.current?.click()}><UploadCloud size={13} /> Choose file</button>
        {pending && <span className="dim" style={{ fontSize: 11 }}>{pending.name} — {pending.pids.length.toLocaleString("en-IN")} PIDs</span>}
      </div>
      {pending && (
        <button type="button" className="button primary" disabled={uploading} onClick={apply}>
          {uploading ? "Replacing…" : `Replace ${label} list`}
        </button>
      )}
      {error && <div className="alert error">⚠ {error}</div>}
      <span className="dim" style={{ fontSize: 10 }}>CSV / TXT / TSV — first column read as Product IDs; a header row is skipped automatically.</span>
    </div>
  );
}

function ResetButton({ onReload }: { onReload: () => void }) {
  const [resetting, setResetting] = useState(false);
  async function reset() {
    if (!confirm("Reset both PID lists to the bundled defaults?\n\nAny uploaded overrides will be discarded.")) return;
    setResetting(true);
    try {
      const res = await fetch("/api/delay-dashboard/pid-masters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      const payload = await res.json();
      if (!res.ok || payload.ok !== true) throw new Error(payload.error || `Request failed (${res.status})`);
      onReload();
    } finally {
      setResetting(false);
    }
  }
  return (
    <button type="button" className="button danger" disabled={resetting} onClick={reset}>
      <RotateCcw size={13} /> {resetting ? "Resetting…" : "Reset both lists to bundled defaults"}
    </button>
  );
}
