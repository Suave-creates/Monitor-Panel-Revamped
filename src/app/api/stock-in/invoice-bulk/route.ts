import { NextResponse } from "next/server";

import {
  fetchJson,
  mapLimit,
  NEXS_BASE_URL,
  operationalHeaders,
  withAuthRetry,
} from "@/utils/nexs/request";
import { cached, cacheKey, type CacheMeta } from "@/utils/server/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 2 * 60_000;
const MAX_INVOICES = 100;
const CONCURRENCY = 6;
const SEARCH_URL = `${NEXS_BASE_URL}/search/purchaseInvoice?version=v1`;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

type JsonObject = Record<string, unknown>;
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

type InvoiceLookup = {
  invoiceNumber: string;
  hits: number;
  row: InvoiceRow | null;
};

class InputError extends Error {}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function cell(object: JsonObject, key: string): Cell {
  const value = object[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function normalizeFacility(value: unknown): string {
  const facility = typeof value === "string" ? value.trim().toUpperCase() : "NXS1";
  if (!/^[A-Z0-9_-]{2,16}$/.test(facility)) {
    throw new InputError("Facility must contain 2 to 16 letters, numbers, underscores, or hyphens.");
  }
  return facility;
}

function normalizeInvoices(value: unknown): string[] {
  if (!Array.isArray(value)) throw new InputError("invoiceNumbers must be an array.");
  const invoices: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") throw new InputError("Every invoice number must be text.");
    const invoice = candidate.trim().replace(/\s+/g, " ").toUpperCase();
    if (!invoice) continue;
    if (!/^[A-Z0-9][A-Z0-9._ /-]{0,79}$/.test(invoice)) {
      throw new InputError(`Invalid invoice number: ${invoice.slice(0, 24)}`);
    }
    if (!seen.has(invoice)) {
      seen.add(invoice);
      invoices.push(invoice);
    }
  }
  if (!invoices.length) throw new InputError("Enter at least one invoice number.");
  if (invoices.length > MAX_INVOICES) {
    throw new InputError(`A maximum of ${MAX_INVOICES} invoice numbers is allowed per request.`);
  }
  return invoices;
}

function mapInvoice(payload: unknown, invoiceNumber: string): InvoiceLookup {
  const data = asObject(asObject(payload).data);
  const rows = Array.isArray(data.results) ? data.results : [];
  const source = rows.length ? asObject(rows[0]) : null;
  const reportedHits = typeof data.hits === "number" && Number.isFinite(data.hits)
    ? Math.max(0, Math.trunc(data.hits))
    : rows.length;

  if (!source) return { invoiceNumber, hits: reportedHits, row: null };
  return {
    invoiceNumber,
    hits: reportedHits,
    row: {
      vendorInvoiceNumber: cell(source, "vendor_invoice_number"),
      invoiceReferenceNumber: cell(source, "invoice_ref_number"),
      purchaseOrderNumber: cell(source, "po_num"),
      status: cell(source, "status"),
      totalInvoiceQuantity: cell(source, "total_invoice_qty"),
      acceptedQuantity: cell(source, "order_accepted_quantity"),
      pendingQuantity: cell(source, "order_pending_quantity"),
      rejectedQuantity: cell(source, "order_rejected_quantity"),
      invoiceDate: cell(source, "invoice_date"),
      createdAt: cell(source, "created_at"),
      closedAt: cell(source, "closed_at"),
      createdBy: cell(source, "created_by"),
      vendorId: cell(source, "vendor_id"),
      facilityCode: cell(source, "facility_code"),
      legalOwner: cell(source, "legal_owner"),
      prefilledInvoice: cell(source, "prefilled_invoice"),
      totalSamplingQuantity: cell(source, "total_sampling_qty"),
      qcDone: cell(source, "qc_done"),
      qcPass: cell(source, "qc_pass"),
    },
  };
}

function publicError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "The NexS request timed out.";
  if (error instanceof Error && error.message.startsWith("NexS authentication")) return error.message;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return `NexS rejected the invoice lookup (HTTP ${status}).`;
  return "The invoice lookup failed. Retry in a moment.";
}

async function loadInvoice(
  request: Request,
  invoiceNumber: string,
  facility: string,
): Promise<InvoiceLookup> {
  const appId = process.env.NEXS_SEARCH_APP_ID || process.env.NEXS_APP_ID || "nexs_search";
  return withAuthRetry(request, appId, "all", async (auth) => {
    const payload = await fetchJson<unknown>(SEARCH_URL, {
      method: "POST",
      headers: {
        ...operationalHeaders(facility),
        ...auth,
        Referer: `${NEXS_BASE_URL}/invoice/dashboard`,
      },
      body: JSON.stringify({
        type: "purchaseInvoice",
        pageRequest: {
          pageNumber: 0,
          pageSize: 25,
          sortKey: "created_at",
          sortOrder: "DESC",
        },
        global_vendor_invoice_number: invoiceNumber,
      }),
    });
    return mapInvoice(payload, invoiceNumber);
  });
}

export async function POST(request: Request) {
  try {
    const body = asObject(await request.json().catch(() => {
      throw new InputError("Request body must be valid JSON.");
    }));
    const invoiceNumbers = normalizeInvoices(body.invoiceNumbers);
    const facility = normalizeFacility(body.facility);
    const force = body.force === true;

    const results = await mapLimit(invoiceNumbers, CONCURRENCY, async (invoiceNumber) => {
      try {
        const result = await cached(
          cacheKey("invoice", { facility, invoiceNumber }),
          CACHE_TTL_MS,
          () => loadInvoice(request, invoiceNumber, facility),
          force,
        );
        return { ...result.value, cache: result.cache, error: null as string | null };
      } catch (error) {
        return {
          invoiceNumber,
          hits: 0,
          row: null,
          cache: null as CacheMeta | null,
          error: publicError(error),
        };
      }
    });

    return NextResponse.json({
      ok: true,
      facility,
      count: results.length,
      results,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof InputError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 400, headers: NO_STORE_HEADERS });
    }
    console.error("[invoice-bulk] request failed", error);
    return NextResponse.json({ ok: false, error: "Unable to process invoice lookups." }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
