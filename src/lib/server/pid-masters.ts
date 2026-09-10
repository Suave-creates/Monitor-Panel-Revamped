// src/lib/server/pid-masters.ts
//
// Persistence for the NJIT Progressive PID master lists — ported from the
// NJIT Prog Tracker extension's pidstore.js. Classifies lens Product IDs
// as Cylindrical / Non-Cylindrical (Stock Progressive) so the delay
// dashboard can filter and label orders as Single Vision vs. Stock
// Progressive.
//
// This repo has no database configured (no prisma/schema.prisma, no
// DATABASE_URL) — structure.md's mydb guidance is for a sister repo that
// does. Standing up Postgres + Prisma from scratch for one small
// ops-editable singleton record would be disproportionate infrastructure
// for this data, so this stores the (rarely-updated, admin-managed)
// override as a JSON file under `data/`, falling back to the bundled
// defaults when no override exists. If this repo gains a real database
// later, this is the one module that would move to it.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  PID_MASTERS_DEFAULT_CYL,
  PID_MASTERS_DEFAULT_NONCYL,
  PID_MASTERS_DEFAULT_SOURCE,
  PID_MASTERS_DEFAULT_UPDATED_AT,
} from "./pidMastersDefaults";

export type PidMastersRecord = {
  updatedAt: string;
  source: string;
  cyl: string[];
  noncyl: string[];
};

const OVERRIDE_PATH = path.join(process.cwd(), "data", "delay-dashboard", "pid-masters-override.json");

function splitList(csv: string): string[] {
  return csv.split(",").map((p) => p.trim()).filter(Boolean);
}

function defaults(): PidMastersRecord {
  return {
    updatedAt: PID_MASTERS_DEFAULT_UPDATED_AT,
    source: PID_MASTERS_DEFAULT_SOURCE,
    cyl: splitList(PID_MASTERS_DEFAULT_CYL),
    noncyl: splitList(PID_MASTERS_DEFAULT_NONCYL),
  };
}

function isValidRecord(value: unknown): value is PidMastersRecord {
  const record = value as PidMastersRecord | null;
  return !!record && Array.isArray(record.cyl) && Array.isArray(record.noncyl)
    && typeof record.updatedAt === "string" && typeof record.source === "string";
}

export async function getPidMasters(): Promise<PidMastersRecord> {
  try {
    const raw = await fs.readFile(OVERRIDE_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isValidRecord(parsed)) return parsed;
  } catch {
    // No override on disk yet, or it's unreadable/corrupt — fall back to the bundled defaults.
  }
  return defaults();
}

/** Replaces one side's list (cyl or noncyl) and persists the override,
 *  keeping the other side untouched — mirrors pidstore.js's replaceList(). */
export async function savePidMastersSide(side: "cyl" | "noncyl", pids: string[], source?: string): Promise<PidMastersRecord> {
  const current = await getPidMasters();
  const clean = [...new Set(pids.map((p) => String(p).trim()).filter(Boolean))];
  const next: PidMastersRecord = {
    updatedAt: new Date().toISOString(),
    source: source?.trim() || current.source || "uploaded",
    cyl: side === "cyl" ? clean : current.cyl,
    noncyl: side === "noncyl" ? clean : current.noncyl,
  };
  await fs.mkdir(path.dirname(OVERRIDE_PATH), { recursive: true });
  await fs.writeFile(OVERRIDE_PATH, JSON.stringify(next), "utf8");
  return next;
}

/** Clears the override so the next read falls back to the bundled defaults. */
export async function resetPidMasters(): Promise<PidMastersRecord> {
  try {
    await fs.unlink(OVERRIDE_PATH);
  } catch {
    // Nothing to remove — already at defaults.
  }
  return defaults();
}
