// src/app/delay-dashboard/lib/pidClassify.ts
//
// Stock Progressive / Single Vision classification — ported from the
// NJIT Prog Tracker extension's pidstore.js. An order's lens Product IDs
// are checked against two master lists (Cylindrical / Non-Cylindrical);
// hits in only one list classify the order, hits in both make it Mixed,
// and — unlike the source extension, which drops unmatched orders
// entirely since it only tracks progressives — no hits in either list
// means the order is Single Vision, not excluded. Every order on this
// dashboard is one or the other.

export type LensClass = "CYL" | "NONCYL" | "MIXED" | "SV";

export type LensTypeFilter =
  | "all"
  | "single_vision"
  | "stock_progressive"
  | "stock_progressive_cyl"
  | "stock_progressive_noncyl"
  | "stock_progressive_mixed";

export const LENS_CLASS_LABEL: Record<LensClass, string> = {
  CYL: "Stock Progressive · Cylindrical",
  NONCYL: "Stock Progressive · Non-Cylindrical",
  MIXED: "Stock Progressive · Mixed",
  SV: "Single Vision",
};

export type PidSets = { cyl: Set<string>; noncyl: Set<string> };

export function buildPidSets(cyl: string[], noncyl: string[]): PidSets {
  return { cyl: new Set(cyl), noncyl: new Set(noncyl) };
}

/** Classify one order from its distinct lens Product IDs. */
export function classifyLensPids(lensPids: string[], sets: PidSets): LensClass {
  let cylHit = false, nonHit = false;
  for (const raw of lensPids) {
    const p = String(raw).trim();
    if (!p) continue;
    if (sets.cyl.has(p)) cylHit = true;
    if (sets.noncyl.has(p)) nonHit = true;
  }
  if (cylHit && nonHit) return "MIXED";
  if (cylHit) return "CYL";
  if (nonHit) return "NONCYL";
  return "SV";
}

export function matchesLensTypeFilter(cls: LensClass, filter: LensTypeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "single_vision") return cls === "SV";
  if (filter === "stock_progressive") return cls !== "SV";
  if (filter === "stock_progressive_cyl") return cls === "CYL";
  if (filter === "stock_progressive_noncyl") return cls === "NONCYL";
  return cls === "MIXED";
}

/* ── Item-level helpers (frame vs. left/right lens) ──────────────────── */
export function isLensItemType(itemType: unknown): boolean {
  const t = String(itemType ?? "").toUpperCase().replace(/[\s_-]+/g, "");
  return t === "LEFTLENS" || t === "RIGHTLENS" || t.includes("LENS");
}
export function lensSideOf(itemType: unknown): "L" | "R" | null {
  const t = String(itemType ?? "").toUpperCase().replace(/[\s_-]+/g, "");
  if (t === "LEFTLENS") return "L";
  if (t === "RIGHTLENS") return "R";
  return null;
}
const ACCESSORY = /(BAG|CASE|CLOTH|POUCH|COVER|SOLUTION|WIPE|FREEBIE|GIFT|BOX|CHAIN|CORD)/;
export function isCoreItemType(itemType: unknown): boolean {
  const t = String(itemType ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  return t.length > 0 && !ACCESSORY.test(t);
}
