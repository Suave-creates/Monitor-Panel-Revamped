import { NextResponse } from "next/server";
import { fetchJson, mapLimit, NEXS_BASE_URL, operationalHeaders, withAuthRetry } from "@/utils/nexs/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const BARCODE_TIMEOUT_MS = 10_000;
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" ? value.trim() || null : typeof value === "number" ? String(value) : null;
}
function timestamp(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : -Infinity;
}
function normalizeBarcode(value: string) {
  return value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").toUpperCase();
}

export async function POST(request: Request) {
  let body: RecordValue;
  try { body = object(await request.json()); }
  catch { return NextResponse.json({ error: "Invalid JSON request." }, { status: 400, headers }); }
  if (!Array.isArray(body.barcodes) || !body.barcodes.length || body.barcodes.length > 10_000) {
    return NextResponse.json({ error: "Each chunk must contain between 1 and 10,000 barcodes." }, { status: 400, headers });
  }
  const barcodes: string[] = [];
  const seenBarcodes = new Set<string>();
  for (const candidate of body.barcodes) {
    const barcode = typeof candidate === "string" ? normalizeBarcode(candidate) : "";
    if (!/^[A-Z0-9][A-Z0-9._:/-]{11}$/.test(barcode)) {
      return NextResponse.json({ error: `Invalid barcode ${JSON.stringify(barcode.slice(0, 100))}. Use exactly 12 barcode characters, starting with a letter or number.` }, { status: 400, headers });
    }
    if (!seenBarcodes.has(barcode)) {
      seenBarcodes.add(barcode);
      barcodes.push(barcode);
    }
  }
  const appId = process.env.NEXS_IMS_APP_ID || process.env.NEXS_WMS_APP_ID || "nexs_wms";
  const results = await mapLimit(barcodes, 100, async (barcode) => {
    const empty = { barcode, pid: null, latestLocation: null, latestFacility: null, locations: [] as string[], updatedAt: null, updatedBy: null };
    try {
      const payload = await withAuthRetry(request, appId, "all", (auth) => fetchJson<unknown>(`${NEXS_BASE_URL}/nexs/api/ims/getHistory`, {
        method: "POST",
        headers: { ...operationalHeaders(), ...auth, Referer: `${NEXS_BASE_URL}/historyPage/${encodeURIComponent(barcode)}` },
        body: JSON.stringify({ type: "barcode", pageRequest: { sortKey: "updatedAt", sortOrder: "DESC" }, barcode }),
      }, BARCODE_TIMEOUT_MS, "barcode-b"));
      const response = object(payload);
      const data = object(response.data);
      const search = object(data.searchResultResponse);
      if (response.success === false || !Array.isArray(search.results)) throw new Error("Unexpected history response");
      const events = search.results.map(object).sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
      const current = object(data.currentStatusSearchResultResponse);
      const hasCurrent = Object.keys(current).length > 0;
      const latest = hasCurrent && (!events.length || timestamp(current.updatedAt) >= timestamp(events[0].updatedAt)) ? current : events[0];
      const locations: string[] = [];
      const seen = new Set<string>();
      for (const event of events) {
        const location = text(event.location);
        if (location && !seen.has(location.toUpperCase())) {
          seen.add(location.toUpperCase());
          locations.push(location);
          if (locations.length === 4) break;
        }
      }
      return { ...empty, pid: text(latest?.pid) || text(current.pid) || text(events.find((event) => text(event.pid))?.pid), latestLocation: text(latest?.location), latestFacility: text(latest?.facility), locations, updatedAt: text(latest?.updatedAt), updatedBy: text(latest?.updatedBy), error: null, found: Boolean(latest), skipped: false };
    } catch (error) {
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        return { ...empty, error: "Skipped: response exceeded 10 seconds.", found: false, skipped: true };
      }
      const status = (error as { status?: number })?.status;
      const message = error instanceof Error && error.message.startsWith("NexS server authentication")
        ? error.message : status ? `History lookup failed (HTTP ${status}).` : "History lookup failed. Please retry.";
      return { ...empty, error: message, found: false, skipped: false };
    }
  });
  return NextResponse.json({ results }, { headers });
}
