// src/utils/nexs/auth.ts
//
// Server-side NexS authentication: logs in to the NexS auth API with stored
// credentials, obtains a `jwt-token`, caches it, and auto-refreshes before it
// expires. Browser credentials are never accepted or forwarded.
//
// Configure via env (no secrets in source):
//   NEXS_AUTH_URL       full login endpoint (POST) that returns/sets the jwt-token
//   NEXS_USERNAME       NexS login username / email / emp-code (emp-code, e.g. 197531)
//   NEXS_PASSWORD       NexS login password
//   NEXS_APP_ID         value of the `x-lenskart-app-id` header (app identifier the
//                       frontend hardcodes) — REQUIRED, else login → 400 "Invalid app"
//   NEXS_FACILITY       optional facility-code header (default NXS1)
//   NEXS_WORKSTATION    optional workstation-id header (default QC01)
// Confirmed via live probes: body must be exactly {"userName","password"} (strict
// schema — extra keys → "Invalid request json body"); the app identifier is the
// HEADER `x-lenskart-app-id` (not a body field); the JWT is returned in the JSON
// response body (field `content`) and/or as a Set-Cookie jwt-token=…

type Cached = { token: string; expMs: number };
// Per-app-id caches. The auth-service mints a DIFFERENT token per
// x-lenskart-app-id, and each downstream service only accepts its own app's
// token (e.g. /nexs/wms rejects an nexs-analytics token). Key by app-id.
const cache = new Map<string, Cached>();
const inFlight = new Map<string, Promise<string | null>>();
const rejectedUntil = new Map<string, number>();

const SKEW_MS = 60_000; // refresh a minute before expiry

function jwtExpMs(token: string): number | null {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function jwtString(value: unknown): string | null {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
    ? value
    : null;
}

async function login(appId: string): Promise<string | null> {
  const url = process.env.NEXS_AUTH_URL;
  const user = process.env.NEXS_USERNAME;
  const pass = process.env.NEXS_PASSWORD;
  if (!url || !user || !pass) return null; // not configured

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'source-domain': 'https://app.nexs.lenskart.com',
    'facility-code': process.env.NEXS_FACILITY || 'NXS1',
    'workstation-id': process.env.NEXS_WORKSTATION || 'QC01',
  };
  // App identifier header (frontend hardcodes this). Without a valid value the
  // auth-service replies 400 "Invalid app". The token is scoped to this app —
  // only that app's downstream service will accept it.
  if (appId) headers['x-lenskart-app-id'] = appId;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ userName: user, password: pass }),
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });

  // The token comes back in the JSON body (field `content`) and/or as a
  // Set-Cookie jwt-token=… — accept whichever is present.
  const setCookie = res.headers.get('set-cookie') || '';
  const fromCookie = setCookie.match(/jwt-token=([^;]+)/)?.[1];
  let token: string | null = fromCookie || null;
  const text = await res.text();
  if (!token) {
    try {
      const json = JSON.parse(text);
      const content = json?.content;
      token =
        jwtString(content) ||
        jwtString(content?.jwtToken) ||
        jwtString(content?.token) ||
        jwtString(json?.jwtToken) ||
        jwtString(json?.token) ||
        jwtString(json?.accessToken);
    } catch { token = null; }
  }
  if (!res.ok || !token) {
    console.error('[nexsAuth] login failed', res.status, `(app ${appId})`);
    return null;
  }

  const expMs = jwtExpMs(token) ?? Date.now() + 30 * 60_000; // fallback 30m
  cache.set(appId, { token, expMs });
  return token;
}

/**
 * Get a valid NexS jwt-token for the given app, logging in / refreshing as
 * needed. `appId` defaults to NEXS_APP_ID; pass an explicit app-id (e.g.
 * 'nexs_wms') when the target service only accepts its own app's token.
 */
export async function getNexsToken(appId?: string, force = false): Promise<string | null> {
  const key = appId || process.env.NEXS_APP_ID || '';
  if (force) {
    cache.delete(key);
    rejectedUntil.delete(key);
  } else if ((rejectedUntil.get(key) || 0) > Date.now()) {
    return null;
  }
  const hit = cache.get(key);
  if (hit && hit.expMs - SKEW_MS > Date.now()) return hit.token;
  const pending = inFlight.get(key);
  if (pending) return pending;                // single-flight per app-id
  const p = login(key)
    .then((token) => {
      if (token) rejectedUntil.delete(key);
      else rejectedUntil.set(key, Date.now() + 15_000);
      return token;
    })
    .catch((error) => {
      rejectedUntil.set(key, Date.now() + 15_000);
      throw error;
    })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

/**
 * Drop the cached token for an app so the next getNexsToken() logs in fresh.
 * Call this after a downstream 401 ("Invalid Session" / expired): NexS single
 * sign-on can REVOKE a session while the JWT is still inside its exp window
 * (e.g. the same user logs in elsewhere), so the time-based cache alone can hand
 * back a dead token forever.
 */
export function invalidateNexsToken(appId?: string, failedToken?: string | null): void {
  const key = appId || process.env.NEXS_APP_ID || '';
  const current = cache.get(key);
  if (!failedToken || current?.token === failedToken) cache.delete(key);
}

/** Back off after a freshly minted token is also rejected (usually a bad app ID). */
export function rejectNexsToken(appId?: string, failedToken?: string | null): void {
  const key = appId || process.env.NEXS_APP_ID || '';
  invalidateNexsToken(key, failedToken);
  rejectedUntil.set(key, Date.now() + 30_000);
}

export function nexsAuthConfigured(): boolean {
  return !!(process.env.NEXS_AUTH_URL && process.env.NEXS_USERNAME && process.env.NEXS_PASSWORD);
}
