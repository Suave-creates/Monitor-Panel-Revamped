
# NexS Ascend Repository Structure

This document is the structural guide for this repository. The application is
a Next.js App Router project. New work should stay simple: each page owns its
feature, global layout is rendered once, shared components are kept to a
minimum, and application persistence uses only the `mydb` Prisma schema.

## Core rules

1. A feature is centered on one self-contained `page.tsx`.
2. A feature that needs a backend gets one matching API `route.ts`.
3. `Header` and `Sidebar` are rendered once by the root layout, never by an
   individual page.
4. Page-specific UI, state, types, and handlers stay with that page.
5. `src/components` is only for the global shell and small, truly generic UI
   primitives.
6. `prisma/schema.prisma` and `DATABASE_URL` are the only Prisma schema and
   datasource to use for new application work. This database is referred to as
   `mydb`.
7. Add the fewest database tables and columns required by the feature.

## Repository map

```text
NexS-Ascend-New/
|-- prisma/
|   |-- schema.prisma              # mydb schema: the DB source of truth
|   `-- migrations/                # versioned mydb schema changes
|-- public/                        # static files served by Next.js
|-- scripts/                       # maintenance, seed, import, and build scripts
|-- src/
|   |-- app/
|   |   |-- layout.tsx             # global shell; mounts Header + Sidebar once
|   |   |-- globals.css            # global styles and design tokens
|   |   |-- page.tsx               # home route (/)
|   |   |-- api/                   # server-side HTTP route handlers
|   |   |   `-- <module>/
|   |   |       `-- <feature>/
|   |   |           `-- route.ts
|   |   `-- <module>/               # business area, e.g. omt or stock-in
|   |       `-- <feature>/
|   |           `-- page.tsx        # complete feature UI
|   |-- components/
|   |   |-- Header.tsx             # one global header
|   |   |-- Sidebar.tsx            # one global navigation sidebar
|   |   `-- ui/                    # minimal reusable UI primitives
|   |-- generated/
|   |   `-- mydb/                  # generated Prisma client; never hand-edit
|   |-- lib/
|   |   `-- server/                # server-only helpers for complex features
|   |-- middleware/                # request/auth middleware
|   |-- services/                  # exceptional large domain services
|   `-- utils/
|       `-- prisma.ts              # the single reusable mydb Prisma client
|-- database/                      # database operations/maintenance material
|-- ddl/                           # legacy/reference SQL; not the app schema source
|-- docker/                        # container support files
|-- package.json                   # scripts and dependencies
|-- next.config.ts                 # Next.js configuration
|-- tsconfig.json                  # TypeScript configuration and @/* alias
`-- structure.md                   # this document
```

The application currently has feature modules such as `asrs`, `cl-cls`,
`infocorner`, `lens-lab`, `manual-warehouse`, `metal-frame`, `omt`,
`operations`, `packing-dispatch`, and `stock-in`. Add a feature to the closest
existing module instead of creating another top-level module without a clear
need.

Generated output, build output, dependencies, exports, logs, and local data are
not part of the authored application structure. Do not design features around
`src/generated`, `.next`, `node_modules`, CSV/XLSX dumps, or log files.

## Self-contained page structure

The default feature has only two authored files:

```text
src/app/<module>/<feature>/page.tsx
src/app/api/<module>/<feature>/route.ts    # only when an API is required
```

For example:

```text
src/app/operations/tray-scanner/page.tsx
src/app/api/operations/tray-scanner/route.ts
```

The page owns its:

- feature-specific state and effects;
- data loading and event handlers;
- page-specific types and constants;
- form, table, modal, and dashboard markup;
- loading, empty, success, and error states.

Do not create a shared component merely to shorten `page.tsx`. In particular,
do not build a cross-feature component controlled by a `kind`, `mode`, or
`variant` prop. Duplication between independent pages is preferable to hidden
coupling between them.

If a page becomes genuinely too large to understand (normally more than about
600 lines), helpers may be colocated inside that feature only:

```text
src/app/<module>/<feature>/
|-- page.tsx
|-- types.ts
|-- components/                    # used only by this feature
`-- lib/                           # used only by this feature
```

These local files must not be imported by sibling features. Reusable server
logic that is too large for `route.ts` may instead live in
`src/lib/server/<feature>.ts`.

## Header, sidebar, and shared components

The root layout is the only owner of the application shell:

```tsx
// src/app/layout.tsx
<body>
  <Sidebar />
  <div>
    <Header />
    <main>{children}</main>
  </div>
</body>
```

Therefore, feature pages must not import or render `Header`, `Sidebar`, another
application shell, or a second top-level navigation. A page returns only its
content for `<main>`.

Keep `src/components` minimal:

- `Header.tsx` and `Sidebar.tsx` define the global shell.
- `ui/` contains only generic visual primitives such as `Button`, `Input`,
  `Card`, `Modal`, and `Table`.
- A component tied to one business feature belongs in that feature's route
  folder, not in `src/components`.
- Do not add module-level component collections such as
  `src/components/stock-in` for new work.

Navigation links are maintained in `src/components/Sidebar.tsx`; the feature
itself must not duplicate navigation configuration.

## Prisma and `mydb`

New application code must use this one path:

```text
DATABASE_URL
    -> prisma/schema.prisma
    -> src/generated/mydb
    -> src/utils/prisma.ts
    -> API route
```

Responsibilities:

| File or value            | Purpose                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `DATABASE_URL`         | Connection string for`mydb`; keep it in environment files   |
| `prisma/schema.prisma` | Models, relations, constraints, indexes, and client generator |
| `prisma/migrations/`   | Reviewed, versioned changes to`mydb`                        |
| `src/generated/mydb/`  | Generated client output; never edit it manually               |
| `src/utils/prisma.ts`  | Singleton Prisma client used by server code                   |

Use the singleton in a route handler:

```ts
import prisma from '@/utils/prisma';

export async function GET() {
  const rows = await prisma.example.findMany();
  return Response.json(rows);
}
```

Never instantiate `PrismaClient` in a page or route, query Prisma from a client
component, or import directly from `src/generated/mydb`. Browser pages call an
API route; the API route uses `@/utils/prisma`.

The repository contains other Prisma schema/client files for existing legacy
integrations. They are outside the scope of this structure. Do not add a new
schema, generated client, datasource variable, or dependency on those databases
for new work unless the project scope is explicitly changed. For normal work,
"the database" means `mydb`.

### Minimal table policy

Before adding a table to `prisma/schema.prisma`, confirm that the information:

1. must survive application restarts;
2. cannot be derived reliably from an existing `mydb` table or source; and
3. has its own identity or lifecycle.

Prefer one feature-owned table with only required columns. Add relations,
unique constraints, and indexes only for real access patterns. Do not add:

- duplicate tables for alternate views of the same data;
- tables used only to hold temporary UI state;
- speculative columns for possible future requirements;
- a generic catch-all table shared by unrelated features;
- a second table when a query or computed response is enough.

Reuse an existing table only when it represents the same business entity. Do
not overload an unrelated table simply to avoid a migration.

When a schema change is necessary, update `prisma/schema.prisma`, create a
named migration, review the generated SQL, and regenerate the `mydb` client.
The schema and migration must be committed together. Never hand-edit generated
client files or treat files under `ddl/` as the Prisma source of truth.

## Request flow

```text
Browser
  -> self-contained page.tsx
  -> /api/<module>/<feature>
  -> route.ts
  -> @/utils/prisma
  -> mydb
```

Pages should not access databases, environment secrets, filesystem resources,
or external systems directly. Those operations belong in the server-side API
route or, when substantial, a named helper under `src/lib/server`.

## New feature checklist

1. Select the closest existing module.
2. Create one self-contained `page.tsx`.
3. Add one matching `route.ts` only if server work is needed.
4. Use the existing global `Header` and `Sidebar`; do not render them again.
5. Keep page-specific code inside the feature folder.
6. Add a sidebar link if the page is user-facing.
7. Use `@/utils/prisma` and only `mydb` when persistence is needed.
8. Reuse a correct existing table or add the smallest necessary model and
   migration.
9. Do not edit generated Prisma files.
10. Run the relevant type, test, and build checks before handoff.

Existing parts of the repository may not yet follow every rule above. Treat
those as legacy code to improve incrementally, not as templates for new work.
