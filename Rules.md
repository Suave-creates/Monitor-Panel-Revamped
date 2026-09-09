
# NexS Ascend — Structure Rules

This document defines how the app is organized and how every new module or
feature must be added. It is not a style guide, it is a structural contract.
If a change doesn't fit this shape, the plan is wrong, not the rule.

## 1. The core rule: one route, one page, one file

Every feature is a single URL. That URL gets **exactly one self-contained
`page.tsx`** and, if it needs a backend, **exactly one `route.ts`**. Nothing
else.

```
src/app/<module>/<feature>/page.tsx        <- the entire UI for this feature
src/app/api/<module>/<feature>/route.ts    <- the entire backend for this feature
```

"Self-contained" means the page owns its state, its effects, its handlers,
and its markup, in that one file. Do not split a single feature's UI into a
`components/` folder just to make the file shorter. Do not extract a shared
component that a `kind` prop switches between two features. A page file
being 200-700 lines is normal and fine — that is the cost of keeping a
feature legible in one place instead of spread across a directory tree.

Reference implementations (read these before building anything new):

- [src/app/packing-dispatch/fr0/page.tsx](src/app/packing-dispatch/fr0/page.tsx) — 177 lines, single file, one API route
- [src/app/operations/tray-scanner/page.tsx](src/app/operations/tray-scanner/page.tsx) — 124 lines, single file, one API route

**The only permitted exception** is when one feature is genuinely too large
for a single file (600+ lines and still growing). Even then:

- Any extra files (`components/`, `lib/`, `types.ts`) live **inside that
  feature's own folder** — e.g. `cl-cls/consolidate/components/`,
  `cl-cls/consolidate/lib/` — never in a shared, cross-feature location.
- They belong to that one feature only. If a sibling feature needs the same
  logic, **duplicate it into the sibling's own folder**. Do not create a
  shared component that both features import and branch on internally.
- A stub page that just renders `<SomeSharedDashboard kind="x" />` is always
  wrong. If you're writing that, stop — you are about to repeat the mistake
  in §3.

One route folder per feature. Do not create a second route (e.g. a
`history/` sub-route, a `v2/` folder, a parallel page) for what is really
the same feature with a different view — add a tab, a query param, or a
toggle inside the one page instead.

## 2. Adding a new module or feature — the checklist

To add a brand-new feature, do exactly this:

1. **Pick the module.** Use an existing top-level folder under `src/app/`
   (`stock-in`, `packing-dispatch`, `cl-cls`, `operations`, `omt`, etc.) if
   the feature belongs there. Only create a new top-level module folder if
   it genuinely doesn't belong to any existing one.
2. **Create the page:** `src/app/<module>/<feature>/page.tsx`. Build the
   whole UI here: state, data fetching, handlers, markup. Import shared
   primitives from `@/components/ui` (see §4) — do not hand-roll buttons,
   cards, inputs, or modals.
3. **Create the API route (if needed):** `src/app/api/<module>/<feature>/route.ts`.
   Put the whole handler here. If you truly need a secondary read-only
   sub-endpoint (e.g. a polling stats counter), a small nested route like
   `<feature>/stats/route.ts` is acceptable — see
   [src/app/api/packing-dispatch/fr0/stats/route.ts](src/app/api/packing-dispatch/fr0/stats/route.ts)
   (25 lines). That is the only kind of route-splitting allowed, and it
   must stay small.
4. **Add domain logic only if it doesn't fit in the route file**, and put it
   in `src/lib/<feature>.ts` or `src/lib/server/<feature>.ts` — named after
   the feature, not the module, so it doesn't silently become a dumping
   ground shared by unrelated features in the same module.
5. **Wire up navigation** in [src/components/Sidebar.tsx](src/components/Sidebar.tsx).
6. **No inline scripts in route folders.** If a feature genuinely needs a
   Python (or other non-Node) script, it does not live next to `route.ts`.
   See §5.

That's it. If your feature needs more steps than this, the feature is too
big for one page and needs the "large feature" exception in §1 — it does
not need a new pattern.

## 3. What NOT to do — the counter-example

`src/app/stock-in/lens-decanting` and `src/app/stock-in/frame-decanting`
are the reference example of how **not** to structure a feature. Do not
imitate any part of this. Concretely, it got it wrong by:

- **The page is not self-contained.** Both `page.tsx` files are 5-line
  stubs that just do:
  ```tsx
  import DecantingDashboard from '@/components/stock-in/DecantingDashboard';
  export default function LensDecantingPage() {
    return <DecantingDashboard kind="lens" />;
  }
  ```

  All 962 lines of real UI live in
  [src/components/stock-in/DecantingDashboard.tsx](src/components/stock-in/DecantingDashboard.tsx),
  outside both route folders, shared between two different routes and
  switched at runtime by a `kind: 'lens' | 'frame'` prop. This is exactly
  the shared cross-feature component the exception in §1 forbids.
- **Two "route folders" for one feature.** Lens and frame are really one
  feature (decanting) with a variant, but it was split into two full
  route+API trees instead of one page handling both variants.
- **Backend scripts embedded inside the route folder.** `fetch_external.py`
  sits directly next to `route.ts` in both
  `src/app/api/stock-in/lens-decanting/` and `.../frame-decanting/`, and
  `route.ts` shells out to it with `child_process.spawn`. A shared helper,
  `decanting_xlsx.py`, sits loose at the `src/app/api/stock-in/` module
  root instead of belonging to any one feature folder.
- **Build config had to special-case it.** `next.config.ts` needed manual
  `outputFileTracingIncludes` entries to drag along `.py` scripts, `.csv`
  files, and an `.xlsx` workbook that Next's file tracer can't discover on
  its own — a sign the layout doesn't fit how this app is built and
  deployed.
- **It also drifted onto the wrong design language** (§4) — it uses none of
  `@/components/ui` and hand-rolls its own dark theme.

If you are extending stock-in decanting, or anything shaped like it, treat
this as tech debt to route around, not a pattern to extend. Do not add a
third `<x>-decanting` folder or a third `kind` to the switch.

## 4. Two design languages

The app currently has two visual systems in production. Only one of them is
correct for new work.

### Language A — the shared kit (use this for all new pages)

Built REFFERED from `@/components/ui`
([src/components/ui/index.ts](src/components/ui/index.ts)): `Button`,
`Input`, `Textarea`, `Select`, `Field`, `Label`, `Card` / `CardHeader` /
`CardBody`, `PageHeader`, `Modal`, `Alert`, `Badge`, `StatusPill`, `Table`
family, `StatCard`, `Spinner`. THIS IS JUST THE REFERENCE Build your own

Driven by Tailwind v4 theme tokens in
[src/app/globals.css](src/app/globals.css):

```css
/* NexS Ascend — unified design tokens (Tailwind v4 @theme) */
--color-brand-700: #1f295c;   /* brand navy, anchor color */
--color-good-600: #1a7a4a;
--color-notice-600: #e8650a;
--color-danger-600: #c0392b;
```

Light surfaces (`bg-white`, `bg-gray-50`, `border-gray-200`), brand-navy
accents, semantic good/notice/danger colors for status. This is the system
[src/components/Sidebar.tsx](src/components/Sidebar.tsx) itself uses, and
the large majority of pages already use it (e.g.
`packing-dispatch/fr0`, `operations/tray-scanner`, `omt/dashboard`).

**Every new page must use Language A.** Import primitives from
`@/components/ui`, use the `brand-*` / `good-*` / `notice-*` / `danger-*`
tokens, do not invent new colors or hand-roll a button/card/input.

### Language B — the dark analytics style (legacy, do not extend)

A hand-rolled dark theme with no shared components: `bg-[#0c0d0f]`,
`bg-zinc-900`, `text-zinc-100`, teal/rose/amber accents, e.g.:

```tsx
<div className="-m-6 min-h-full bg-[#0c0d0f] p-4 text-zinc-100 sm:p-6">
```

This exists only in `stock-in`'s analytics-style pages
(`bermuda-triangle-analytics`, `decanting-analytics`,
`manual-warehouse-analytics`, `nxs1-good-analytics`, `reserve-inventory`)
and in `DecantingDashboard.tsx`. It imports nothing from `@/components/ui`
and does not use the `brand-*` tokens.
Or there are others LIKE `omt`'s Shopfloor Working tools `tray-putaway` or `CL CLs`'s `consolidate`

**Do not write new pages in Language B.** It is not a themeable alternative,
it is undocumented drift. If you touch one of the pages above, prefer
migrating it to Language A over extending its dark styling further.

## 5. Backend scripts (Python, etc.)

Node/TypeScript route handlers are the only thing allowed directly in a
`route.ts` file. If a feature needs a non-Node script (Python for a data
pull, an Excel export, etc.):

- It must not live inside `src/app/api/<module>/<feature>/`. Route folders
  are for `route.ts` (and the small nested-route exception in §2) only.
- Put it under `src/lib/server/` or a dedicated `scripts/` location, named
  for the feature it serves, and invoke it from the route file with
  `child_process.spawn`/`execFile` — the invocation lives in the route, the
  script itself does not.
- Do not require manual `next.config.ts` `outputFileTracingIncludes`
  entries to ship a feature. If you find yourself adding one, the script or
  data file is in the wrong place — move it, don't patch the build config
  around it.

## 6. Quick reference

| Do                                                              | Don't                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------- |
| One`page.tsx` per route, fully self-contained                 | A stub page delegating to a shared cross-feature component    |
| One`route.ts` per API endpoint                                | Splitting one feature's backend across multiple route folders |
| Helpers colocated inside the*one* feature's own folder        | Helpers shared across sibling features via a`kind` switch   |
| Import UI from`@/components/ui`, use `brand-*` tokens       | Hand-rolled dark`zinc-900`/teal/rose styling                |
| Scripts invoked from the route, stored under`src/lib/server/` | `.py` files sitting next to `route.ts`                    |
