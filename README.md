# NexS Operations Console

A Next.js web application that consolidates the Chrome-extension tools from
`all (1).zip` and `DO Dashboardv2 (1).zip` into one operations workspace.
Browser-extension APIs have been removed: the browser talks only to same-origin
Next.js routes, and those routes authenticate to NexS on the server.

## Run locally

```powershell
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:3000`. Copy `.env.example` to `.env` when setting
up a new machine; never expose NexS credentials through `NEXT_PUBLIC_*` values.

Production mode fails closed unless `APP_BASIC_AUTH_USER` and
`APP_BASIC_AUTH_PASSWORD` are configured. Development mode permits local access
without them. Basic authentication must be served through an HTTPS reverse
proxy (and preferably the corporate VPN); replace the access gate with company
SSO when an identity provider integration is available.

### Run with Docker

Copy `.env.example` to `.env`, fill in the NexS and application-access
credentials, then:

```powershell
docker compose up --build -d
docker compose ps
```

The production container runs as a non-root user with a read-only filesystem,
uses `/api/health?ready=1` for its configuration-readiness check, and does not
copy `.env` files or the source ZIP archives into the image. Compose binds to
`127.0.0.1:3000` by default. Change `APP_PORT` for another port; set
`APP_BIND_ADDRESS=0.0.0.0` only when an authenticated TLS reverse proxy or a
trusted private-network boundary protects the service.

## Modules

- KPI Dashboard — D1/D2/NDD completion and fulfilment-stage visibility
- DO Visibility — distributor-order shipment and PID pendency
- Inventory Fetcher — consolidated inventory and product metadata
- Barcode Intelligence — barcode stock and movement history
- Invoice Lookup — bulk purchase-invoice search

## Load protection and caching

The server uses a bounded in-memory TTL cache shared by all requests in a Node
process. It also uses single-flight request coalescing: if many users request the
same data simultaneously, only one upstream request runs and every caller shares
its result. A process-wide concurrency limiter (default `12`) queues different
requests during bursts.

Typical cache policy:

| Data | TTL |
| --- | ---: |
| Live KPI dashboard | 15 seconds |
| KPI dashboard stage export | 30 seconds |
| DO dashboard | 20 seconds |
| DO shipment details | 1 minute |
| Invoice, inventory, barcode lookups | 2 minutes |
| Product catalog / infocorner totals | 6 hours |

Set `NEXS_MAX_CONCURRENCY` and `NEXS_MAX_QUEUE` to tune the upstream ceiling.
The cache is bounded by entry count and approximate memory, with single-entry
and in-flight caps. Manual refreshes have a five-second server cooldown and
still coalesce with an identical refresh already in progress.

The in-memory cache is appropriate for one long-running app server. A future
horizontally scaled deployment should replace its storage with Redis so cache
entries and concurrency limits are shared across instances; feature contracts do
not otherwise need to change.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
```

Live routes require the Lenskart network/VPN, valid NexS credentials, and the
correct app-scoped IDs for the services in use. The application never returns a
JWT or server credential to the browser.

Do not distribute `.next/standalone` from a local build performed beside a
secret-bearing `.env`; Next.js may copy environment files into that generated
folder. The Docker build is isolated by `.dockerignore` and is the supported
production artifact.
