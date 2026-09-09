import { createHash } from "node:crypto";

type CacheEntry<T> = {
  value: T;
  createdAt: number;
  expiresAt: number;
  sizeBytes: number;
};

type CacheState = {
  values: Map<string, CacheEntry<unknown>>;
  flights: Map<string, Promise<unknown>>;
  totalBytes: number;
  lastSweepAt: number;
};

declare global {
  var __nexsOperationsCache: CacheState | undefined;
}

const state: CacheState = globalThis.__nexsOperationsCache ?? {
  values: new Map(),
  flights: new Map(),
  totalBytes: 0,
  lastSweepAt: 0,
};

globalThis.__nexsOperationsCache = state;

const configuredEntries = Number(process.env.NEXS_CACHE_MAX_ENTRIES || 750);
const configuredMegabytes = Number(process.env.NEXS_CACHE_MAX_MB || 128);
const configuredEntryMegabytes = Number(process.env.NEXS_CACHE_MAX_ENTRY_MB || 16);
const configuredFlights = Number(process.env.NEXS_CACHE_MAX_FLIGHTS || 500);
const configuredForceCooldown = Number(process.env.NEXS_FORCE_REFRESH_COOLDOWN_MS || 5_000);
const MAX_ENTRIES = Number.isFinite(configuredEntries)
  ? Math.max(100, Math.min(5_000, Math.trunc(configuredEntries)))
  : 750;
const MAX_TOTAL_BYTES = (Number.isFinite(configuredMegabytes)
  ? Math.max(16, Math.min(1_024, configuredMegabytes))
  : 128) * 1_024 * 1_024;
const MAX_ENTRY_BYTES = (Number.isFinite(configuredEntryMegabytes)
  ? Math.max(1, Math.min(128, configuredEntryMegabytes))
  : 16) * 1_024 * 1_024;
const MAX_FLIGHTS = Number.isFinite(configuredFlights)
  ? Math.max(50, Math.min(5_000, Math.trunc(configuredFlights)))
  : 500;
const FORCE_REFRESH_COOLDOWN_MS = Number.isFinite(configuredForceCooldown)
  ? Math.max(0, Math.min(60_000, Math.trunc(configuredForceCooldown)))
  : 5_000;

// Survive a development hot reload from an older cache-state shape.
state.totalBytes ||= 0;
state.lastSweepAt ||= 0;

export type CacheMeta = {
  status: "hit" | "miss" | "coalesced";
  ageMs: number;
  ttlMs: number;
};

export type CachedResult<T> = { value: T; cache: CacheMeta };

function removeEntry(key: string) {
  const entry = state.values.get(key);
  if (!entry) return;
  state.totalBytes = Math.max(0, state.totalBytes - (entry.sizeBytes || 0));
  state.values.delete(key);
}

function cleanup(now: number, enforceLimits = false) {
  if (!enforceLimits && now - state.lastSweepAt < 60_000) return;
  for (const [key, entry] of state.values) {
    if (entry.expiresAt <= now) removeEntry(key);
  }
  while (state.values.size > MAX_ENTRIES || state.totalBytes > MAX_TOTAL_BYTES) {
    const oldest = state.values.keys().next().value as string | undefined;
    if (!oldest) break;
    removeEntry(oldest);
  }
  state.lastSweepAt = now;
}

function approximateSize(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized ? Math.max(64, serialized.length * 2) : 64;
  } catch {
    // Cached values are expected to be JSON-compatible. If a future caller
    // supplies something else, keep its accounting conservative.
    return MAX_ENTRY_BYTES + 1;
  }
}

/**
 * Process-wide bounded TTL cache with single-flight request coalescing.
 * A forced refresh skips a stored value but still joins an identical refresh
 * already in progress, protecting upstream services from refresh stampedes.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  bypass = false,
): Promise<CachedResult<T>> {
  const now = Date.now();
  cleanup(now);
  const hit = state.values.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > now && (!bypass || now - hit.createdAt < FORCE_REFRESH_COOLDOWN_MS)) {
    return { value: hit.value, cache: { status: "hit", ageMs: now - hit.createdAt, ttlMs } };
  }

  const pending = state.flights.get(key) as Promise<T> | undefined;
  if (pending) {
    const value = await pending;
    const entry = state.values.get(key);
    return {
      value,
      cache: { status: "coalesced", ageMs: entry ? Date.now() - entry.createdAt : 0, ttlMs },
    };
  }

  if (state.flights.size >= MAX_FLIGHTS) {
    throw new Error("The shared request cache is busy. Please retry shortly.");
  }

  const flight = loader().then((value) => {
    const createdAt = Date.now();
    const sizeBytes = approximateSize(value);
    removeEntry(key);
    if (sizeBytes <= MAX_ENTRY_BYTES) {
      state.values.set(key, { value, createdAt, expiresAt: createdAt + ttlMs, sizeBytes });
      state.totalBytes += sizeBytes;
      cleanup(createdAt, true);
    }
    return value;
  }).finally(() => state.flights.delete(key));

  state.flights.set(key, flight);
  const value = await flight;
  return { value, cache: { status: "miss", ageMs: 0, ttlMs } };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  }
  return value;
}

export function cacheKey(namespace: string, input: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(stable(input)))
    .digest("hex")
    .slice(0, 24);
  return `${namespace}:${digest}`;
}

export function clearCacheNamespace(namespace: string) {
  for (const key of state.values.keys()) {
    if (key.startsWith(`${namespace}:`)) removeEntry(key);
  }
}
